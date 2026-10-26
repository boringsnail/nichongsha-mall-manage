<template>
  <div class="dash" v-loading="loading">
    <!-- 工具条：范围切换 + 数据时点 -->
    <div class="bar">
      <div class="bar-left">
        <span class="label">range</span>
        <el-radio-group v-model="days" size="small" @change="load">
          <el-radio-button :value="7">近 7 天</el-radio-button>
          <el-radio-button :value="30">近 30 天</el-radio-button>
          <el-radio-button :value="90">近 90 天</el-radio-button>
        </el-radio-group>
      </div>
      <div class="bar-right">
        <span class="mono stamp">数据截至 {{ updatedText }}</span>
        <el-button size="small" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <!-- 仪表读数：一格一个指标，发丝线分隔，不做六张卡片 -->
    <section class="panel kpi-panel">
      <div v-for="card in statCards" :key="card.label" class="kpi" :class="card.tone">
        <div class="label">{{ card.label }}</div>
        <div class="kpi-val">
          <span class="num">{{ card.value }}</span>
          <span class="unit">{{ card.unit }}</span>
        </div>
      </div>
    </section>

    <!-- 趋势 + 漏斗 -->
    <div class="grid cols-2-1">
      <section class="panel">
        <div class="panel-hd">
          <span class="rule-title">近 {{ days }} 天经营趋势</span>
          <span class="label">gmv / orders</span>
        </div>
        <div class="panel-bd">
          <div ref="trendRef" class="chart" />
        </div>
      </section>

      <section class="panel">
        <div class="panel-hd">
          <span class="rule-title">转化漏斗</span>
          <span class="label">session</span>
        </div>
        <div class="panel-bd">
          <div ref="funnelRef" class="chart" />
          <div v-if="funnel && funnel.worst" class="worst">
            最大流失 {{ funnel.worst.from }} → {{ funnel.worst.to }}
            <strong class="num">{{ funnel.worst.dropRate }}%</strong>
          </div>
        </div>
      </section>
    </div>

    <!-- 经营建议：按严重程度排序的待办清单 -->
    <section class="panel">
      <div class="panel-hd">
        <span class="rule-title">经营建议</span>
        <span class="label">{{ advice.length }} items</span>
      </div>
      <div class="panel-bd advice-bd">
        <div v-if="advice.length === 0" class="empty">各项指标均在健康区间，暂无建议</div>
        <div v-for="(a, i) in advice" :key="i" class="advice" :class="a.level">
          <span class="advice-tag mono">{{ levelText(a.level) }}</span>
          <div class="advice-body">
            <div class="advice-title">{{ a.title }}</div>
            <div class="advice-detail">{{ a.detail }}</div>
          </div>
        </div>
      </div>
    </section>

    <!-- TOP 商品 + 低库存 -->
    <div class="grid cols-2-1">
      <section class="panel">
        <div class="panel-hd">
          <span class="rule-title">商品销量 TOP {{ topProducts.length || 10 }}</span>
          <span class="label">近 {{ days }} 天</span>
        </div>
        <div class="panel-bd">
          <div ref="topRef" class="chart chart-sm" />
        </div>
      </section>

      <section class="panel">
        <div class="panel-hd">
          <span class="rule-title">低库存预警</span>
          <span class="label">stock ≤ 10</span>
        </div>
        <div class="panel-bd lowstock-bd">
          <div v-if="lowStock.length === 0" class="empty">暂无低库存商品</div>
          <el-table v-else :data="lowStock" size="small">
            <el-table-column label="商品" min-width="120">
              <template #default="{ row }">
                <div class="prod">{{ row.productName }}</div>
                <div class="muted">{{ row.specName }}</div>
              </template>
            </el-table-column>
            <el-table-column label="库存" width="70" align="right">
              <template #default="{ row }">
                <span class="mono stock" :class="row.stock <= 5 ? 'crit' : 'warn'">{{ row.stock }}</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import * as echarts from 'echarts/core';
import { BarChart, FunnelChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ECharts } from 'echarts/core';
import { ElMessage } from 'element-plus';
import {
  adminAdvice,
  adminFunnel,
  adminLowStock,
  adminOverview,
  adminTopProducts,
  adminTrend,
  type Advice,
  type FunnelData,
  type LowStockSku,
  type Overview,
  type TopProduct,
  type TrendPoint,
} from '@/api/stats';
import { fenToYuan } from '@/utils/money';

// 按需注册，避免整包打入（Dashboard chunk 可减小数百 KB）
echarts.use([
  BarChart,
  LineChart,
  FunnelChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);

// ---- 图表色板：与设计令牌保持一致，canvas 里必须显式给色 ----
const SIGNAL = '#2ee6c5';
const AMBER = '#f5b544';
const AXIS = '#27353d';
const AXIS_LABEL = '#61747f';
const TEXT_MID = '#9cb0bb';
const MONO = 'JetBrains Mono Variable, monospace';
// 漏斗用信号色的明度阶梯，比彩虹色更像仪表
const FUNNEL_RAMP = ['#2ee6c5', '#28c4a9', '#22a48d', '#1c8471', '#176556'];

const tooltipStyle = {
  backgroundColor: '#162127',
  borderColor: '#27353d',
  borderWidth: 1,
  padding: [8, 10] as [number, number],
  textStyle: { color: '#e9f1f5', fontSize: 11, fontFamily: MONO },
  extraCssText: 'box-shadow: 0 12px 32px rgba(0,0,0,.55); border-radius: 2px;',
};

const axisCommon = {
  axisLine: { lineStyle: { color: AXIS } },
  axisTick: { show: false },
  axisLabel: { color: AXIS_LABEL, fontSize: 10, fontFamily: MONO },
};

const loading = ref(false);
const days = ref(30);
const overview = ref<Overview | null>(null);
const trend = ref<TrendPoint[]>([]);
const funnel = ref<FunnelData | null>(null);
const advice = ref<Advice[]>([]);
const topProducts = ref<TopProduct[]>([]);
const lowStock = ref<LowStockSku[]>([]);
const updatedText = ref('—');

const statCards = computed(() => {
  const o = overview.value;
  const ship = o?.toShip ?? 0;
  const low = o?.lowStockCount ?? 0;
  return [
    { label: '今日 GMV', value: o ? fenToYuan(o.today.gmv) : '—', unit: '元', tone: '' },
    { label: '今日销量', value: o?.today.salesCount ?? '—', unit: '件', tone: '' },
    { label: '今日订单', value: o?.today.orderCount ?? '—', unit: '单', tone: '' },
    { label: `近 ${days.value} 天 GMV`, value: o ? fenToYuan(o.week.gmv) : '—', unit: '元', tone: '' },
    // 待发货与低库存是「要动手」的指标，用琥珀色跳出来
    { label: '待发货', value: o?.toShip ?? '—', unit: '单', tone: ship > 0 ? 'warn' : '' },
    { label: '低库存', value: o?.lowStockCount ?? '—', unit: 'SKU', tone: low > 0 ? 'crit' : '' },
  ];
});

function levelText(level: Advice['level']) {
  return level === 'danger' ? '紧急' : level === 'warn' ? '关注' : '提示';
}

// ---- 图表实例 ----
const trendRef = ref<HTMLElement | null>(null);
const funnelRef = ref<HTMLElement | null>(null);
const topRef = ref<HTMLElement | null>(null);
let trendChart: ECharts | null = null;
let funnelChart: ECharts | null = null;
let topChart: ECharts | null = null;

function renderTrend(points: TrendPoint[]) {
  if (!trendRef.value) return;
  if (!trendChart) trendChart = echarts.init(trendRef.value);
  trendChart.setOption(
    {
      tooltip: { trigger: 'axis', ...tooltipStyle, axisPointer: { lineStyle: { color: AXIS } } },
      legend: {
        data: ['GMV', '订单数'],
        right: 0,
        top: 0,
        itemWidth: 10,
        itemHeight: 2,
        itemGap: 16,
        textStyle: { color: TEXT_MID, fontSize: 10, fontFamily: MONO },
      },
      grid: { left: 52, right: 52, top: 44, bottom: 28 },
      xAxis: {
        type: 'category',
        data: points.map((p) => p.date.slice(5)),
        ...axisCommon,
        axisLabel: { ...axisCommon.axisLabel, interval: points.length > 20 ? 'auto' : 0 },
      },
      yAxis: [
        {
          type: 'value',
          name: 'GMV',
          nameTextStyle: { color: AXIS_LABEL, fontSize: 10, fontFamily: MONO, align: 'right' },
          ...axisCommon,
          splitLine: { lineStyle: { color: 'rgba(39,53,61,0.55)', type: 'dashed' } },
          axisLabel: {
            ...axisCommon.axisLabel,
            formatter: (v: number) => (v >= 10000 ? `${v / 10000}w` : `${v}`),
          },
        },
        {
          type: 'value',
          name: '订单',
          nameTextStyle: { color: AXIS_LABEL, fontSize: 10, fontFamily: MONO },
          ...axisCommon,
          minInterval: 1,
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'GMV',
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 4,
          showSymbol: points.length <= 14,
          data: points.map((p) => Number((p.gmv / 100).toFixed(2))),
          lineStyle: { width: 2, color: SIGNAL },
          itemStyle: { color: SIGNAL },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(46,230,197,0.22)' },
              { offset: 1, color: 'rgba(46,230,197,0)' },
            ]),
          },
        },
        {
          name: '订单数',
          type: 'bar',
          yAxisIndex: 1,
          data: points.map((p) => p.orderCount),
          barMaxWidth: 10,
          // 次要序列用低饱和琥珀，避免抢走 GMV 主线的视觉重量
          itemStyle: { color: 'rgba(245,181,68,0.34)' },
        },
      ],
    },
    true
  );
}

function renderFunnel(data: FunnelData | null) {
  if (!funnelRef.value) return;
  if (!funnelChart) funnelChart = echarts.init(funnelRef.value);
  const stages = data?.stages ?? [];
  // 全 0 时漏斗会渲染成空白，给递减占位值保留图形轮廓（仅展示用）
  const hasData = stages.some((s) => s.value > 0);
  funnelChart.setOption(
    {
      tooltip: {
        trigger: 'item',
        ...tooltipStyle,
        formatter: (p: unknown) => {
          const item = p as { dataIndex: number };
          const s = stages[item.dataIndex];
          if (!s) return '';
          return `${s.label}<br/>会话 ${s.value}<br/>较首级 ${s.rate}%`;
        },
      },
      series: [
        {
          type: 'funnel',
          left: '4%',
          right: '4%',
          top: 8,
          bottom: 8,
          minSize: '24%',
          maxSize: '100%',
          sort: 'none',
          gap: 2,
          label: {
            show: true,
            position: 'inside',
            color: '#04201b',
            fontSize: 11,
            fontFamily: MONO,
            fontWeight: 600,
          },
          labelLine: { show: false },
          itemStyle: { borderColor: '#111a1e', borderWidth: 1 },
          data: stages.map((s, i) => ({
            name: `${s.label} ${s.rate}%`,
            value: hasData ? s.value : Math.max(stages.length - i, 1),
            itemStyle: { color: FUNNEL_RAMP[i % FUNNEL_RAMP.length] },
          })),
        },
      ],
    },
    true
  );
}

function renderTop(products: TopProduct[]) {
  if (!topRef.value) return;
  if (!topChart) topChart = echarts.init(topRef.value);
  topChart.setOption(
    {
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle,
        formatter: (params: unknown) => {
          const items = params as { name: string; value: number; marker: string }[];
          if (!items.length) return '';
          const p = products.find((x) => x.name === items[0].name);
          return items
            .map((i) => `${i.marker}${i.name}：${i.value} 件`)
            .concat(p ? [`GMV：${fenToYuan(p.gmv)} 元`] : [])
            .join('<br/>');
        },
      },
      grid: { left: 44, right: 16, top: 18, bottom: 52 },
      xAxis: {
        type: 'category',
        data: products.map((p) => p.name),
        ...axisCommon,
        axisLabel: { ...axisCommon.axisLabel, interval: 0, rotate: 24, width: 84, overflow: 'truncate' },
      },
      yAxis: {
        type: 'value',
        ...axisCommon,
        minInterval: 1,
        splitLine: { lineStyle: { color: 'rgba(39,53,61,0.55)', type: 'dashed' } },
      },
      series: [
        {
          type: 'bar',
          data: products.map((p) => p.salesCount),
          barMaxWidth: 26,
          itemStyle: { color: SIGNAL, opacity: 0.85 },
        },
      ],
    },
    true
  );
}

function handleResize() {
  trendChart?.resize();
  funnelChart?.resize();
  topChart?.resize();
}

async function load() {
  loading.value = true;
  try {
    const d = Number(days.value);
    const [o, tr, fn, ad, tp, ls] = await Promise.all([
      adminOverview(),
      adminTrend(d),
      adminFunnel(d),
      adminAdvice(d),
      adminTopProducts({ days: d, limit: 10 }),
      adminLowStock(10),
    ]);
    overview.value = o;
    trend.value = tr;
    funnel.value = fn;
    advice.value = ad;
    topProducts.value = tp;
    lowStock.value = ls;
    updatedText.value = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    await nextTick();
    renderTrend(tr);
    renderFunnel(fn);
    renderTop(tp);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  window.addEventListener('resize', handleResize);
  load();
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize);
  trendChart?.dispose();
  funnelChart?.dispose();
  topChart?.dispose();
  trendChart = null;
  funnelChart = null;
  topChart = null;
});
</script>

<style scoped>
.dash {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.bar-left,
.bar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.stamp {
  font-size: 10.5px;
  color: var(--text-lo);
  letter-spacing: 0.06em;
}

/* ─────────── 仪表读数条 ─────────── */
.kpi-panel {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
}
.kpi {
  padding: 14px 16px 15px;
  border-right: 1px solid var(--line-1);
  min-width: 0;
}
.kpi:last-child {
  border-right: none;
}
.kpi-val {
  display: flex;
  align-items: baseline;
  gap: 5px;
  margin-top: 8px;
}
.kpi-val .num {
  font-size: 24px;
  font-weight: 500;
  line-height: 1.1;
  color: var(--text-hi);
}
.unit {
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--text-lo);
}
.kpi.warn .kpi-val .num {
  color: var(--amber);
}
.kpi.crit .kpi-val .num {
  color: var(--red);
}

/* ─────────── 栅格 ─────────── */
.grid {
  display: grid;
  gap: 12px;
}
.cols-2-1 {
  grid-template-columns: minmax(0, 1.95fr) minmax(0, 1fr);
}

.chart {
  height: 320px;
}
.chart-sm {
  height: 288px;
}

.empty {
  padding: 22px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-lo);
}

.worst {
  margin-top: 8px;
  padding: 7px 10px;
  border: 1px solid rgba(245, 181, 68, 0.28);
  background: var(--amber-soft);
  color: var(--amber);
  font-size: 11px;
  text-align: center;
  letter-spacing: 0.02em;
}
.worst strong {
  font-weight: 600;
  margin-left: 2px;
}

/* ─────────── 经营建议：像运维日志 ─────────── */
.advice-bd {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0;
}
.advice {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 12px 16px;
  border-left: 2px solid var(--line-2);
  background: transparent;
  transition: background var(--dur-1) var(--ease);
}
.advice:hover {
  background: rgba(233, 241, 245, 0.02);
}
.advice.info {
  border-left-color: var(--blue);
}
.advice.warn {
  border-left-color: var(--amber);
}
.advice.danger {
  border-left-color: var(--red);
}
.advice-tag {
  flex: none;
  margin-top: 1px;
  padding: 1px 6px;
  border: 1px solid var(--line-2);
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--text-lo);
}
.advice.info .advice-tag {
  color: var(--blue);
  border-color: rgba(106, 168, 255, 0.32);
}
.advice.warn .advice-tag {
  color: var(--amber);
  border-color: rgba(245, 181, 68, 0.32);
}
.advice.danger .advice-tag {
  color: var(--red);
  border-color: rgba(255, 95, 87, 0.32);
}
.advice-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-hi);
  margin-bottom: 3px;
}
.advice-detail {
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-mid);
}

/* ─────────── 低库存 ─────────── */
.lowstock-bd {
  padding: 0;
}
.lowstock-bd .el-table {
  --el-table-border-color: var(--line-1);
}
.prod {
  line-height: 1.3;
}
.stock {
  font-size: 13px;
}
.stock.warn {
  color: var(--amber);
}
.stock.crit {
  color: var(--red);
  font-weight: 600;
}

@media (max-width: 1280px) {
  .kpi-panel {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .kpi:nth-child(3n) {
    border-right: none;
  }
  .kpi:nth-child(-n + 3) {
    border-bottom: 1px solid var(--line-1);
  }
  .cols-2-1 {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
