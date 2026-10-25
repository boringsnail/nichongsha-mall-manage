/**
 * 告警外发（可选能力）。
 *
 * 只依赖一个 webhook URL：企业微信群机器人 / 钉钉群机器人 / 飞书群机器人都能收文本。
 * 没配置就退化成日志 —— 提醒失败绝不能拖累售后、退款、发货这些主流程，
 * 因此这里所有异常都被吞掉并降级为 warn。
 *
 * 配置：AFTER_SALE_ALERT_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
 */

function webhookUrl(): string {
  return (process.env.AFTER_SALE_ALERT_WEBHOOK ?? '').trim();
}

export function alertWebhookConfigured(): boolean {
  return webhookUrl().length > 0;
}

/**
 * 推一条文本告警。返回是否真的推成功了（未配置时返回 false）。
 * 企业微信与钉钉的文本消息体一致；飞书需要 msg_type 字段，这里额外带上不影响前两者。
 */
export async function pushAlert(title: string, lines: string[]): Promise<boolean> {
  const content = [title, ...lines].join('\n');
  const url = webhookUrl();
  if (!url) {
    console.log(`[alert] ${content}`);
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content } }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[alert] webhook 返回 HTTP ${res.status}，告警内容：${content}`);
      return false;
    }
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[alert] webhook 发送失败（${reason}），告警内容：${content}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
