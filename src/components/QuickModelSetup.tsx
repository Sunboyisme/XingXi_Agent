import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ArrowRight, ExternalLink, Loader2 } from "lucide-react";
import { api, type Settings } from "@/lib/api";
import type { components } from "@/lib/api.generated";
import { errorMessage } from "@/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ErrorNotice } from "./common";
import "../styles/quick-model-setup.css";

type Preset = components["schemas"]["QuickPresetRead"];
type Result = components["schemas"]["QuickSetupRead"];

export function QuickModelSetup({
  onSaved,
}: {
  onSaved: (settings: Settings) => void;
}) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const request = useRef<AbortController | null>(null);
  const saving = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoadError("");
    void api<Preset[]>("/settings/quick-setup", "GET", undefined, {
      signal: controller.signal,
      timeoutMs: 10000,
    })
      .then((value) => {
        if (!controller.signal.aborted) setPresets(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => () => request.current?.abort(), []);

  function close(open: boolean) {
    if (saving.current || open) return;
    setPreset(null);
    setKey("");
    setError("");
    setResult(null);
  }
  async function save() {
    if (!preset || saving.current) return;
    if (!key.trim()) {
      setError("请粘贴 API Key。");
      return;
    }
    saving.current = true;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    request.current = controller;
    try {
      const value = await api<Result>(
        "/settings/quick-setup",
        "POST",
        {
          provider: preset.provider,
          api_key: key.trim(),
        },
        { signal: controller.signal, timeoutMs: 45000 },
      );
      if (controller.signal.aborted) return;
      setKey("");
      setResult(value);
      onSaved(value.settings);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      saving.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <div className="quick-model-setup">
      <div className="quick-setup-heading">
        <h3>快速配置</h3>
        <p>填一次密钥，配好对话、语音、语义检索和生图。已有设置会保留。</p>
      </div>
      <div className="quick-setup-providers">
        {presets.map((item) => (
          <button
            type="button"
            key={item.provider}
            className="quick-setup-provider"
            onClick={() => {
              setPreset(item);
              setKey("");
              setError("");
              setResult(null);
            }}
          >
            <span>
              <strong>{item.label}</strong>
              <small>{item.description}</small>
            </span>
            <ArrowRight size={17} aria-hidden="true" />
          </button>
        ))}
      </div>
      {loadError && (
        <ErrorNotice
          message={loadError}
          retry={() => setRetry((value) => value + 1)}
        />
      )}
      <Dialog open={Boolean(preset)} onOpenChange={close}>
        <DialogContent
          className="connection-config-dialog quick-setup-dialog"
          showCloseButton={!busy}
        >
          <DialogHeader>
            <DialogTitle>{preset?.label}快速配置</DialogTitle>
            <DialogDescription>
              {result
                ? "配置已保存。各项模型实际调用仍需在使用时确认。"
                : "小希会读取模型列表，选择推荐型号并共用这份密钥。"}
            </DialogDescription>
          </DialogHeader>
          {result ? (
            <div className="quick-setup-results" role="status">
              {result.items.map((item) => (
                <div
                  key={item.capability}
                  className="quick-setup-result"
                  data-state={item.state}
                >
                  <div>
                    <strong>{item.capability}</strong>
                    <span>
                      {
                        {
                          configured: "已配置",
                          preserved: "已保留",
                          unavailable: "待配置",
                        }[item.state]
                      }
                    </span>
                  </div>
                  {item.model && <p>{item.model}</p>}
                  <small>{item.message}</small>
                </div>
              ))}
            </div>
          ) : (
            <div className="quick-setup-form">
              <p className="quick-setup-account-note">
                {preset?.provider === "bailian"
                  ? "先注册并认证阿里云账号，开通北京地域百炼，再创建模型 API Key。其他地域可使用手动添加连接。"
                  : "先注册硅基流动账号，完成实名认证，再创建 API Key。"}
              </p>
              {preset && (
                <a
                  href={preset.key_url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => {
                    if (isTauri()) {
                      event.preventDefault();
                      void invoke("open_external_url", {
                        url: preset.key_url,
                      }).catch((cause) => setError(errorMessage(cause)));
                    }
                  }}
                >
                  获取 API Key <ExternalLink size={13} aria-hidden="true" />
                </a>
              )}
              <div className="form-field">
                <Label htmlFor="quick-setup-key">API Key</Label>
                <Input
                  id="quick-setup-key"
                  type="password"
                  autoComplete="new-password"
                  value={key}
                  disabled={busy}
                  placeholder="粘贴服务商提供的 API Key"
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? "quick-setup-error" : undefined}
                  onChange={(event) => {
                    setKey(event.target.value);
                    setError("");
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void save();
                    }
                  }}
                />
              </div>
              <p className="quick-setup-account-note">
                只补齐未配置的能力，保留已有默认模型。联网搜索在能力连接中单独设置。
              </p>
            </div>
          )}
          {error && (
            <p id="quick-setup-error" className="field-error" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            {result ? (
              <Button onClick={() => close(false)}>完成</Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => close(false)}
                >
                  取消
                </Button>
                <Button disabled={busy} onClick={() => void save()}>
                  {busy && <Loader2 size={14} className="spin" />}
                  {busy ? "正在读取模型并配置…" : "连接并自动配置"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
