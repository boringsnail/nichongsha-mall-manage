import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { adminListAlerts, type AdminAlerts } from '@/api/alerts';
import { fenToYuan } from '@/utils/money';

export type AlertKind = 'order' | 'after-sale';

export interface AlertItem {
  id: string;
  kind: AlertKind;
  title: string;
  /** 主键（订单号 / 售后单号）。弹层里单独占一行，方便对照后台列表 */
  no: string;
  /** 金额、件数、买家这类次要信息 */
  meta: string;
  /** 单行拼接版，用于系统通知与语音之外的长文本场景 */
  detail: string;
  /** 语音播报用的短句 */
  speech: string;
  /** 跳转目标 */
  to: string;
  at: string;
}

const LS_SOUND = 'alert_sound';
const LS_VOICE = 'alert_voice';
const LS_NOTIFY = 'alert_notify';

/** 轮询间隔：20 秒。告警端点只有两条小查询 + 两个 count，成本可忽略。 */
const POLL_MS = 20_000;
const BASE_TITLE = '你宠啥 · 商家调度台';

const readFlag = (key: string, fallback: boolean) => {
  const v = localStorage.getItem(key);
  return v === null ? fallback : v === '1';
};

/**
 * 订单 / 售后强提醒。
 *
 * 三层提示，各自可关：
 *   1. 文字：右上角告警卡（不自动消失太快）+ 侧栏/头部未读角标 + 标签页标题闪烁
 *   2. 声音：Web Audio 现场合成，不依赖音频文件；订单是三音上行，售后是双音下行
 *   3. 语音：浏览器 SpeechSynthesis 中文播报「新订单，45 元」
 *
 * 浏览器要求声音必须在用户手势之后才能播，所以这里维护一个 `unlocked` 状态，
 * 未解锁时界面会显示「点击启用」的提示条。
 */
export const useAlertStore = defineStore('alerts', () => {
  const items = ref<AlertItem[]>([]);
  const unread = ref(0);
  const pendingShipCount = ref(0);
  const pendingAfterSaleCount = ref(0);
  const lastCheck = ref<string | null>(null);
  const connected = ref(true);

  const soundOn = ref(readFlag(LS_SOUND, true));
  const voiceOn = ref(readFlag(LS_VOICE, true));
  const notifyOn = ref(readFlag(LS_NOTIFY, false));
  const unlocked = ref(false);

  const hasUnread = computed(() => unread.value > 0);

  // ---- 内部状态：已见过的单号、是否完成首次基线播种 ----
  const seen = new Set<string>();
  let seeded = false;
  let timer: number | null = null;
  let audioCtx: AudioContext | null = null;
  let flashTimer: number | null = null;
  let ticking = false;

  // ---------------------------------------------------------------- 声音

  function ctx(): AudioContext | null {
    if (audioCtx) return audioCtx;
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
    return audioCtx;
  }

  /** 必须在用户手势里调用，否则浏览器会挂起 AudioContext */
  function unlockAudio(): boolean {
    const c = ctx();
    if (!c) return false;
    if (c.state !== 'running') {
      // resume() 是异步的，但调用发生在手势内就一定放行；先乐观置位，避免提示条闪一下又出现
      void c.resume().then(
        () => {
          unlocked.value = c.state === 'running';
        },
        () => {
          unlocked.value = false;
        },
      );
    }
    unlocked.value = true;
    return true;
  }

  /** 现场合成提示音：指数包络 + 短促音符，比 <audio> 省资源也不会被缓存失效拖累 */
  function chime(notes: number[], type: OscillatorType, spacing = 0.11) {
    if (!soundOn.value) return;
    const c = ctx();
    if (!c || c.state !== 'running') return;
    const now = c.currentTime;
    notes.forEach((freq, i) => {
      const t = now + i * spacing;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.2, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    });
  }

  const chimeOrder = () => chime([880, 1174.7, 1568], 'triangle');
  // 售后用下行双音，一耳朵就能和「新订单」区分开
  const chimeAfterSale = () => chime([622.3, 466.2], 'sawtooth', 0.15);

  // ---------------------------------------------------------------- 语音

  function speak(text: string) {
    if (!voiceOn.value || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 1.05;
    u.pitch = 1;
    // 打断上一句，避免多单时排长队
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  // ---------------------------------------------------------- 桌面通知

  function desktopNotify(title: string, body: string) {
    if (!notifyOn.value) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      new Notification(title, { body, tag: 'nichongsha-alert', requireInteraction: false });
    } catch {
      /* 某些浏览器在非 https / 无权限时会抛错，忽略即可 */
    }
  }

  async function requestNotifyPermission(): Promise<boolean> {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    const res = await Notification.requestPermission();
    return res === 'granted';
  }

  // ------------------------------------------------------------ 标题闪烁

  function startFlash() {
    if (flashTimer !== null) return;
    let on = false;
    flashTimer = window.setInterval(() => {
      on = !on;
      document.title = on ? `【${unread.value} 条待处理】` : BASE_TITLE;
    }, 1100);
  }

  function stopFlash() {
    if (flashTimer !== null) {
      clearInterval(flashTimer);
      flashTimer = null;
    }
    document.title = BASE_TITLE;
  }

  // -------------------------------------------------------------- 轮询

  function toItems(data: AdminAlerts): AlertItem[] {
    const list: AlertItem[] = [];
    for (const a of data.afterSales) {
      const meta = `${a.type === 'REFUND_ONLY' ? '仅退款' : '退货退款'} ¥${fenToYuan(a.refundAmount)} · ${a.reasonText}`;
      list.push({
        id: `a:${a.afterSaleNo}`,
        kind: 'after-sale',
        title: '新的售后申请',
        no: a.afterSaleNo,
        meta,
        detail: `${a.afterSaleNo} · ${meta}`,
        speech: `新的售后申请，金额${fenToYuan(a.refundAmount)}元`,
        to: `/after-sales?orderNo=${a.orderNo}`,
        at: a.createdAt,
      });
    }
    for (const o of data.orders) {
      const meta = `¥${fenToYuan(o.totalAmount)} · ${o.itemCount} 件 · ${o.buyer}`;
      list.push({
        id: `o:${o.orderNo}`,
        kind: 'order',
        title: '新订单待发货',
        no: o.orderNo,
        meta,
        detail: `${o.orderNo} · ${meta}`,
        speech: `新订单，${fenToYuan(o.totalAmount)}元`,
        to: `/orders?orderNo=${o.orderNo}`,
        at: o.createdAt,
      });
    }
    return list.sort((a, b) => +new Date(b.at) - +new Date(a.at));
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const data = await adminListAlerts();
      connected.value = true;
      pendingShipCount.value = data.pendingShipCount;
      pendingAfterSaleCount.value = data.pendingAfterSaleCount;
      lastCheck.value = data.serverTime;

      const all = toItems(data);

      // 首次拉取只播种基线：否则一进后台就把历史单全播一遍，纯噪音
      if (!seeded) {
        for (const it of all) seen.add(it.id);
        seeded = true;
        return;
      }

      const fresh = all.filter((it) => !seen.has(it.id));
      for (const it of fresh) seen.add(it.id);
      if (!fresh.length) return;

      items.value = [...fresh, ...items.value].slice(0, 3);
      unread.value += fresh.length;

      const orders = fresh.filter((f) => f.kind === 'order');
      const sales = fresh.filter((f) => f.kind === 'after-sale');

      if (orders.length) chimeOrder();
      if (sales.length) chimeAfterSale();

      // 一次多单时合并播报，避免语音排队念十遍
      if (orders.length && sales.length) {
        speak(`有${orders.length}个新订单，${sales.length}个新的售后申请`);
      } else if (orders.length > 1) {
        speak(`有${orders.length}个新订单`);
      } else if (orders.length === 1) {
        speak(orders[0].speech);
      } else if (sales.length > 1) {
        speak(`有${sales.length}个新的售后申请`);
      } else if (sales.length === 1) {
        speak(sales[0].speech);
      }

      const head = fresh[0];
      desktopNotify(
        fresh.length > 1 ? `${fresh.length} 条新的待处理` : head.title,
        fresh.length > 1 ? fresh.map((f) => f.detail).join('\n') : head.detail,
      );

      if (document.hidden) startFlash();
    } catch {
      // 网络抖动不弹错，只把状态点打灰；下一轮自动恢复
      connected.value = false;
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer !== null) return;
    void tick();
    timer = window.setInterval(() => void tick(), POLL_MS);
    document.addEventListener('visibilitychange', onVisibility);
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    document.removeEventListener('visibilitychange', onVisibility);
    stopFlash();
  }

  function onVisibility() {
    if (document.hidden) {
      if (unread.value > 0) startFlash();
    } else {
      stopFlash();
    }
  }

  // -------------------------------------------------------------- 交互

  function dismiss(id: string) {
    items.value = items.value.filter((i) => i.id !== id);
  }

  function clearUnread() {
    unread.value = 0;
    items.value = [];
    stopFlash();
  }

  function setSound(on: boolean) {
    soundOn.value = on;
    localStorage.setItem(LS_SOUND, on ? '1' : '0');
    if (on) unlockAudio();
  }

  function setVoice(on: boolean) {
    voiceOn.value = on;
    localStorage.setItem(LS_VOICE, on ? '1' : '0');
    if (on) speak('语音提醒已开启');
  }

  async function setNotify(on: boolean): Promise<boolean> {
    if (on) {
      const ok = await requestNotifyPermission();
      notifyOn.value = ok;
      localStorage.setItem(LS_NOTIFY, ok ? '1' : '0');
      return ok;
    }
    notifyOn.value = false;
    localStorage.setItem(LS_NOTIFY, '0');
    return true;
  }

  /** 设置面板里的「试听」：声音 + 语音一起走一遍 */
  function preview() {
    unlockAudio();
    chimeOrder();
    speak('新订单，128元');
  }

  return {
    items,
    unread,
    hasUnread,
    pendingShipCount,
    pendingAfterSaleCount,
    lastCheck,
    connected,
    soundOn,
    voiceOn,
    notifyOn,
    unlocked,
    start,
    stop,
    tick,
    dismiss,
    clearUnread,
    setSound,
    setVoice,
    setNotify,
    unlockAudio,
    preview,
  };
});
