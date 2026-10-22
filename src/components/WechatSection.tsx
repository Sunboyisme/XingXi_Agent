import { useEffect, useRef, useState } from "react";
import {
  Bell,
  ChevronDown,
  Loader2,
  MessageCircle,
  Send,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import type { components } from "@/lib/api.generated";
import { ErrorNotice } from "./common";
import { dateTime } from "@/lib/utils";
import { ConnectionCard } from "./ConnectionCard";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";

type Status = components["schemas"]["WechatStatus"];
type Delivery = components["schemas"]["WechatDeliveryRead"];
const phases: Record<string, string> = {
  unbound: "未连接",
  waiting: "等待扫码",
  scanned: "请在微信确认",
  need_verifycode: "需要验证码",
  expired: "二维码已过期",
  connected: "已连接",
  connecting: "正在建立连接",
  reconnecting: "正在重连",
  paused: "已暂停",
  needs_login: "请重新扫码",
  error: "连接未完成",
};
const deliveryLabels: Record<string, string> = {
  pending: "等待发送",
  sending: "发送中",
  accepted: "微信接口已接受",
  failed: "发送失败",
  blocked: "等待微信互动",
  uncertain: "送达结果未知",
  cancelled: "已取消",
};

const sendStates: Record<string, string> = {
  error: "暂不可用，请查看发送提示",
  unbound: "请先绑定",
  paused: "已暂停",
  needs_login: "请重新扫码",
  needs_interaction: "请先在微信发一条消息",
  ready: "可以尝试发送",
};
const diagnosticLabels: Record<string, string> = {
  connection: "连接未建立",
  read_timeout: "等待响应超时",
  write_timeout: "发送途中超时",
  invalid_response: "响应格式无法确认",
  interrupted: "发送被中断",
  network_unknown: "网络结果不明",
  http: "HTTP 请求失败",
  business: "微信接口拒绝",
};

export function WechatSection({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const revision = useRef(0);
  const changing = useRef(false);
  const [testDelivery, setTestDelivery] = useState<Delivery | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const testId = useRef("");
  const testRequest = useRef("");
  const sendingTest = useRef(false);
  const testPending =
    testDelivery?.status === "pending" || testDelivery?.status === "sending";
  async function sendTest() {
    if (sendingTest.current || busy || testPending) return;
    sendingTest.current = true;
    setTestBusy(true);
    setError("");
    testId.current = "";
    setTestDelivery(null);
    const currentRevision = revision.current;
    testRequest.current ||= crypto.randomUUID();
    try {
      const result = await api<Delivery>("/wechat/test-message", "POST", {
        request_id: testRequest.current,
      });
      if (currentRevision === revision.current) {
        testId.current = result.id;
        setTestDelivery(result);
        if (!["pending", "sending"].includes(result.status)) {
          testRequest.current = "";
          testId.current = "";
        }
      }
    } catch (cause) {
      if (currentRevision === revision.current)
        setError((cause as Error).message);
    } finally {
      sendingTest.current = false;
      setTestBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const currentRevision = revision.current;
        if (!changing.current) {
          const currentTestId = testId.current;
          const results = await Promise.allSettled([
            api<Status>("/wechat/status"),
            currentTestId
              ? api<Delivery>(`/wechat/deliveries/${currentTestId}`)
              : Promise.resolve(null),
          ]);
          if (active && currentRevision === revision.current) {
            if (results[0].status === "fulfilled")
              setStatus(results[0].value as Status);
            else setError((results[0].reason as Error).message);
            if (
              results[1].status === "fulfilled" &&
              currentTestId === testId.current &&
              results[1].value
            ) {
              const delivery = results[1].value as Delivery;
              setTestDelivery(delivery);
              if (!["pending", "sending"].includes(delivery.status)) {
                testRequest.current = "";
                testId.current = "";
              }
            }
          }
        }
      } catch (cause) {
        if (active) setError((cause as Error).message);
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 2500);
      }
    }
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  async function change(path: string, method: string, body?: unknown) {
    setBusy(true);
    changing.current = true;
    revision.current += 1;
    setError("");
    try {
      const value = await api<Status>(path, method, body);
      setStatus(value);
      if (!value.bound || path === "/wechat/connect") {
        testId.current = "";
        testRequest.current = "";
        setTestDelivery(null);
      }
      setCode("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      changing.current = false;
      setBusy(false);
    }
  }

  const content = (
    <section className="settings-section wechat-section" aria-label="微信连接">
      <div className="section-title">
        <span className="wechat-icon">
          <MessageCircle size={21} />
        </span>
        <div>
          <h2>微信</h2>
          <p>和XiaoXi文字聊天，并接收提醒。</p>
        </div>
        <span
          className={`connection-label ${status?.phase === "connected" ? "ready" : ""}`}
          role="status"
        >
          <span className="connection-dot" aria-hidden="true" />
          {status ? phases[status.phase] || "连接中" : "读取状态…"}
        </span>
      </div>
      <div className="wechat-content">
        {error && <ErrorNotice message={error} />}
        {status?.error &&
          !status.receive_error &&
          !status.send_error &&
          status.error !== error && (
            <div className="wechat-notice" role="alert">
              <TriangleAlert size={17} />
              <p>{status.error}</p>
            </div>
          )}
        {status && (
          <div className="wechat-health" aria-label="微信连接状态">
            <dl className="wechat-health-grid">
              <div>
                <dt>账号绑定</dt>
                <dd>{status.bound ? "已绑定本人微信" : "未绑定"}</dd>
              </div>
              <div>
                <dt>收件连接</dt>
                <dd>{phases[status.phase] || "读取中"}</dd>
              </div>
              <div>
                <dt>提醒同步</dt>
                <dd>{status.reminders_enabled ? "已开启" : "未开启"}</dd>
              </div>
              <div>
                <dt>发送准备</dt>
                <dd>
                  {sendStates[status.send_state || "unbound"] || "读取中"}
                </dd>
              </div>
            </dl>
            <dl className="wechat-health-times">
              <div>
                <dt>最近连接成功</dt>
                <dd>
                  {status.last_connected_at
                    ? dateTime(status.last_connected_at)
                    : "尚无记录"}
                </dd>
              </div>
              <div>
                <dt>最近收到消息</dt>
                <dd>
                  {status.last_received_at
                    ? dateTime(status.last_received_at)
                    : "尚无记录"}
                </dd>
              </div>
              <div>
                <dt>最近尝试发送</dt>
                <dd>
                  {status.last_send_at
                    ? dateTime(status.last_send_at)
                    : "尚无记录"}
                </dd>
              </div>
            </dl>
            {status.receive_error && (
              <p className="wechat-health-error" role="status">
                收件连接：{status.receive_error}
              </p>
            )}
            {status.send_error && (
              <p className="wechat-health-error" role="status">
                发送：{status.send_error}
              </p>
            )}
          </div>
        )}
        {status?.qr_image && (
          <div className="wechat-pairing">
            <img
              src={status.qr_image}
              alt="使用本人微信扫码连接XiaoXi"
              width={240}
              height={240}
              style={{ maxWidth: "100%", height: "auto" }}
            />
            <p>使用本人微信扫码，并在手机上确认。</p>
          </div>
        )}
        {status?.phase === "need_verifycode" && (
          <div className="form-field wechat-verification">
            <Label htmlFor="wechat-code">手机上显示的验证码</Label>
            <Input
              id="wechat-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <Button
              variant="outline"
              disabled={busy || !/^\d{4,8}$/.test(code)}
              onClick={() => void change("/wechat/verify", "POST", { code })}
            >
              确认验证码
            </Button>
          </div>
        )}
        {status?.bound && (
          <label className="wechat-reminder-option">
            <span className="wechat-reminder-label">
              <Bell size={17} />
              <span>到期提醒同时发送到微信</span>
            </span>
            <Checkbox
              checked={status.reminders_enabled}
              disabled={busy || !status.enabled}
              onCheckedChange={(checked) =>
                void change("/wechat/options", "PUT", {
                  enabled: status.enabled,
                  reminders_enabled: checked === true,
                })
              }
            />
          </label>
        )}
        {status?.bound && (
          <div className="wechat-test-message">
            <Button
              variant="outline"
              size="sm"
              disabled={
                busy || testBusy || testPending || status.send_state !== "ready"
              }
              onClick={() => void sendTest()}
            >
              {testBusy || testPending ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Send size={15} />
              )}
              {testPending ? "测试消息发送中…" : "发送测试消息"}
            </Button>
            <p>
              点击后向已绑定本人发送一条固定测试文字，请在手机微信确认收件。
            </p>
            {testDelivery && (
              <p role="status" className="wechat-test-result">
                {testDelivery.status === "accepted"
                  ? "微信接口已接受测试消息，请在手机微信确认收件。"
                  : `${deliveryLabels[testDelivery.status] || testDelivery.status}${testDelivery.error ? `：${testDelivery.error}` : ""}`}
              </p>
            )}
          </div>
        )}
        <div className="wechat-actions">
          <div className="wechat-primary-actions">
            <Button
              variant={status?.bound ? "outline" : "default"}
              size="sm"
              disabled={busy || !status}
              onClick={() => void change("/wechat/connect", "POST")}
            >
              {busy && <Loader2 size={16} className="spin" />}
              {status?.bound
                ? "重新扫码"
                : status?.qr_image
                  ? "刷新二维码"
                  : "连接微信"}
            </Button>
            {status?.bound && status.phase !== "needs_login" && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void change("/wechat/options", "PUT", {
                    enabled: !status.enabled,
                    reminders_enabled: status.reminders_enabled,
                  })
                }
              >
                {status.enabled ? "暂停连接" : "恢复连接"}
              </Button>
            )}
          </div>
          {(status?.bound || status?.qr_image) && (
            <Button
              variant="ghost"
              size="sm"
              className="wechat-unbind"
              disabled={busy}
              onClick={() => void change("/wechat/connection", "DELETE")}
            >
              解除绑定
            </Button>
          )}
        </div>
        <p className="wechat-local-hint">
          需电脑开机并运行XiaoXi；微信可能要求重新互动后才能发送。
        </p>
        {Boolean(status?.deliveries.length) && (
          <details className="wechat-deliveries">
            <summary>
              <span>
                最近投递 <small>{status?.deliveries.length}</small>
              </span>
              <ChevronDown size={15} />
            </summary>
            <ul>
              {status?.deliveries.map((item) => (
                <li key={item.id}>
                  <div className="wechat-delivery-heading">
                    <span
                      className="wechat-delivery-state"
                      data-state={item.status}
                    >
                      {deliveryLabels[item.status] || item.status}
                    </span>
                    <time dateTime={item.created_at}>
                      {dateTime(item.created_at)}
                    </time>
                  </div>
                  {item.error && <p>{item.error}</p>}
                  {item.diagnostics?.error_kind ? (
                    <small className="wechat-delivery-diagnostic">
                      {diagnosticLabels[String(item.diagnostics.error_kind)] ||
                        "发送诊断"}
                      {item.diagnostics.http_status != null &&
                        ` · HTTP ${String(item.diagnostics.http_status)}`}
                      {item.diagnostics.provider_code != null &&
                        ` · 微信代码 ${String(item.diagnostics.provider_code)}`}
                    </small>
                  ) : item.status === "uncertain" ? (
                    <small className="wechat-delivery-diagnostic">
                      历史记录未保存具体原因，无法回溯；请在微信确认。
                    </small>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
  if (!compact) return content;
  return (
    <ConnectionCard
      title="微信连接"
      icon={MessageCircle}
      description="微信聊天与到期提醒"
      status={status ? phases[status.phase] || "读取中" : "读取中"}
      ready={status?.phase === "connected"}
      detail={
        error ||
        status?.error ||
        (status?.bound ? "已绑定本人账号" : "扫码绑定微信账号")
      }
      action="管理"
      onConfigure={() => setOpen(true)}
    >
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="connection-config-dialog wechat-config-dialog">
          <DialogHeader>
            <DialogTitle>微信连接</DialogTitle>
            <DialogDescription>
              管理绑定、连接状态与提醒投递。
            </DialogDescription>
          </DialogHeader>
          {content}
        </DialogContent>
      </Dialog>
    </ConnectionCard>
  );
}
