import { Hint } from "./common";
import { useEffect, useState } from "react";
import { Images, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type { components } from "@/lib/api.generated";
import { ConnectionCard } from "./ConnectionCard";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { SoftSelect } from "./ui/soft-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";

type ImageSettings = components["schemas"]["ImageGenerationRead"];
type TestResult = components["schemas"]["ImageGenerationTestRead"];
const initial: ImageSettings = {
  enabled: false,
  url: "https://api.openai.com/v1",
  model: "",
  size: "",
  response_format: "auto",
  key_configured: false,
};

function isMissingSettings(error: unknown) {
  return error instanceof Error && /^not found$/i.test(error.message.trim());
}

function settingsError(error: unknown) {
  if (isMissingSettings(error))
    return "本机服务尚未加载图片生成配置接口。请通过「文件 → 退出XiaoXi」完全退出，再运行「启动测试版.cmd」。关闭窗口只会隐藏到后台。";
  return error instanceof Error
    ? error.message
    : "读取图片生成配置失败，请重试。";
}

export function ImageGenerationConnection() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(initial);
  const [form, setForm] = useState(initial);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needsRestart, setNeedsRestart] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  function clearResult() {
    setTestResult(null);
    setError("");
  }

  function change(patch: Partial<ImageSettings>) {
    setForm((value) => ({ ...value, ...patch }));
    clearResult();
  }

  function payload() {
    return {
      enabled: form.enabled,
      url: form.url.trim(),
      model: form.model.trim(),
      size: form.size.trim(),
      response_format: form.response_format,
      api_key: clearKey ? "" : key || null,
    };
  }

  useEffect(() => {
    let live = true;
    api<ImageSettings>("/settings/image-generation")
      .then((value) => {
        if (live) {
          setStatus(value);
          setForm(value);
        }
      })
      .catch((error) => {
        if (live) {
          setNeedsRestart(isMissingSettings(error));
          setError(settingsError(error));
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  async function configure() {
    clearResult();
    setLoading(true);
    try {
      const value = await api<ImageSettings>("/settings/image-generation");
      setStatus(value);
      setForm(value);
      setNeedsRestart(false);
      setKey("");
      setClearKey(false);
      setOpen(true);
    } catch (error) {
      setNeedsRestart(isMissingSettings(error));
      setError(settingsError(error));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const value = await api<ImageSettings>(
        "/settings/image-generation",
        "PUT",
        payload(),
      );
      setStatus(value);
      setForm(value);
      setKey("");
      setClearKey(false);
      setNeedsRestart(false);
      setOpen(false);
    } catch (error) {
      setNeedsRestart(isMissingSettings(error));
      setError(settingsError(error));
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    setTesting(true);
    clearResult();
    try {
      setTestResult(
        await api<TestResult>(
          "/settings/image-generation/test",
          "POST",
          payload(),
        ),
      );
      setNeedsRestart(false);
    } catch (error) {
      setNeedsRestart(isMissingSettings(error));
      setError(settingsError(error));
    } finally {
      setTesting(false);
      setBusy(false);
    }
  }

  const configured = Boolean(status.model && status.key_configured);
  const canTest = Boolean(
    form.url.trim() &&
    form.model.trim() &&
    (key.trim() || (status.key_configured && !clearKey)),
  );
  return (
    <ConnectionCard
      title="图片生成"
      description="独立图片模型 · 海报与插画"
      icon={Images}
      ready={!needsRestart && !error && status.enabled && configured}
      status={
        loading
          ? "读取中"
          : needsRestart
            ? "需重启"
            : error && !open
              ? "读取失败"
              : status.enabled && configured
                ? "已启用"
                : configured
                  ? "已配置"
                  : "待配置"
      }
      detail={
        needsRestart
          ? "请完全退出后重新启动测试版"
          : error && !open
            ? error
            : configured
              ? status.model
              : "单独配置生图地址、密钥与模型"
      }
      onConfigure={() => {
        if (!loading) void configure();
      }}
    >
      {!open && error && (
        <div className="image-generation-service-error" role="alert">
          <p>{error}</p>
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => void configure()}
          >
            重新读取配置
          </Button>
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) {
            setOpen(value);
            if (!value) {
              setKey("");
              setClearKey(false);
              setError("");
            }
          }
        }}
      >
        <DialogContent className="connection-config-dialog image-generation-config-dialog">
          <DialogHeader>
            <div className="image-generation-title-row">
              <DialogTitle>图片生成</DialogTitle>
              <label className="image-generation-enable">
                <Checkbox
                  checked={form.enabled}
                  disabled={busy}
                  onCheckedChange={(value) =>
                    change({ enabled: value === true })
                  }
                />
                启用
              </label>
            </div>
            <DialogDescription>
              独立生图模型，由 Agent 按需调用。
            </DialogDescription>
          </DialogHeader>
          <div className="connection-config-fields">
            <div className="form-field image-generation-wide">
              <Label htmlFor="image-generation-url">接口地址</Label>
              <Input
                id="image-generation-url"
                value={form.url}
                disabled={busy}
                onChange={(event) => change({ url: event.target.value })}
                placeholder="服务商基础地址或完整生图地址"
                autoComplete="off"
              />
            </div>
            <div className="form-field">
              <Label htmlFor="image-generation-model">图片模型</Label>
              <Input
                id="image-generation-model"
                value={form.model}
                disabled={busy}
                onChange={(event) => change({ model: event.target.value })}
                placeholder="图片模型名称"
                autoComplete="off"
              />
            </div>
            <div className="form-field">
              <div className="image-generation-key-label">
                <Label htmlFor="image-generation-key">API 密钥</Label>
                {status.key_configured && (
                  <button
                    type="button"
                    className="text-button danger"
                    disabled={busy}
                    aria-label={
                      clearKey ? "撤销清除图片密钥" : "清除已保存的图片密钥"
                    }
                    onClick={() => {
                      setClearKey(!clearKey);
                      setKey("");
                      clearResult();
                    }}
                  >
                    {clearKey ? "撤销清除" : "清除"}
                  </button>
                )}
              </div>
              <Input
                id="image-generation-key"
                type="password"
                value={key}
                disabled={busy}
                onChange={(event) => {
                  setKey(event.target.value);
                  setClearKey(false);
                  clearResult();
                }}
                placeholder={
                  clearKey
                    ? "保存后清除原密钥"
                    : status.key_configured
                      ? "已保存，留空保留"
                      : "填写 API 密钥"
                }
                autoComplete="new-password"
              />
            </div>
            <div className="form-field">
              <Label htmlFor="image-generation-size">尺寸（可选）</Label>
              <Input
                id="image-generation-size"
                value={form.size}
                disabled={busy}
                onChange={(event) => change({ size: event.target.value })}
                placeholder="默认，例如 1024x1024"
                autoComplete="off"
              />
            </div>
            <div className="form-field">
              <Label htmlFor="image-generation-response">返回格式</Label>
              <SoftSelect
                id="image-generation-response"
                label="图片返回格式"
                value={form.response_format}
                disabled={busy}
                onValueChange={(value) =>
                  change({
                    response_format: value as ImageSettings["response_format"],
                  })
                }
                options={[
                  { value: "auto", label: "服务商默认" },
                  { value: "b64_json", label: "Base64" },
                  { value: "url", label: "图片地址" },
                ]}
              />
            </div>
          </div>
          <p className="image-generation-test-note">
            测试会实际生成 1 张图片，可能计费；支持文字生图。
          </p>
          <div
            className="image-generation-test-result"
            data-state={
              error || testResult?.ok === false
                ? "error"
                : testResult?.ok
                  ? "success"
                  : "idle"
            }
            role={error || testResult?.ok === false ? "alert" : "status"}
            aria-live="polite"
          >
            <Hint label={error || testResult?.message || ""}>
              <p>
                {testing
                  ? "正在生成测试图，请稍候…"
                  : error ||
                    testResult?.message ||
                    "可先测试当前填写内容，再保存。百炼 Qwen 自动适配。"}
              </p>
            </Hint>
            {testResult && (
              <>
                <span>
                  {testResult.protocol === "dashscope"
                    ? "百炼原生"
                    : "Images 兼容"}
                  {testResult.width && testResult.height
                    ? ` · ${testResult.width} × ${testResult.height}`
                    : testResult.http_status
                      ? ` · HTTP ${testResult.http_status}`
                      : ""}
                </span>
                <Hint label={testResult.endpoint}>
                  <span className="image-generation-test-endpoint">
                    {testResult.endpoint}
                  </span>
                </Hint>
              </>
            )}
          </div>
          <DialogFooter className="image-generation-dialog-actions">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canTest}
              onClick={() => void testConnection()}
            >
              {testing && <Loader2 size={14} className="spin" />}
              {testing ? "测试中…" : "测试连接"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setKey("");
                clearResult();
              }}
            >
              取消
            </Button>
            <Button
              size="sm"
              disabled={busy || !form.url.trim() || (form.enabled && !canTest)}
              onClick={() => void save()}
            >
              {busy && !testing && <Loader2 size={14} className="spin" />}
              {busy && !testing ? "保存中…" : "保存设置"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConnectionCard>
  );
}
