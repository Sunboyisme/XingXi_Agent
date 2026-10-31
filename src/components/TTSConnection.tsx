import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ExternalLink, Loader2, Square, Undo2, Volume2 } from "lucide-react";
import { api } from "@/lib/api";
import {
  OnlineSpeechPlayer,
  type TTSProfile,
  type TTSSettings,
} from "@/lib/onlineSpeech";
import { errorMessage } from "@/lib/utils";
import { ConnectionCard } from "./ConnectionCard";
import { ErrorNotice } from "./common";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { SoftSelect } from "./ui/soft-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import "../styles/tts-settings.css";
import { SharedCredentialSource } from "./SharedCredentials";

type Editable = Omit<TTSSettings, "profiles"> & {
  profiles: (TTSSettings["profiles"][number] & { api_key?: string | null })[];
};

export function TTSConnection({
  active = true,
  configureRequested = false,
  onConfigureHandled,
}: {
  active?: boolean;
  configureRequested?: boolean;
  onConfigureHandled?: () => void;
}) {
  const [status, setStatus] = useState<TTSSettings>();
  const [form, setForm] = useState<Editable>();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [sample, setSample] = useState(
    "你好，我是 XiaoXi。这是在线语音朗读试听。愿你今天有所收获。",
  );
  const mounted = useRef(false);
  const saveLock = useRef(false);
  const previewActive = useRef(false);
  const previewEpoch = useRef(0);
  const loadEpoch = useRef(0);
  const loader = useRef<AbortController | null>(null);
  const requestHandled = useRef(false);
  const player = useRef<OnlineSpeechPlayer | null>(null);
  if (!player.current) player.current = new OnlineSpeechPlayer();
  const profile = form?.profiles.find(
    (value) => value.provider === form.selected,
  );
  const preset = form?.presets.find(
    (value) => value.provider === form.selected,
  );
  const voiceOptions = preset
    ? profile?.voice &&
      !preset.voices.some((voice) => voice.value === profile.voice)
      ? [
          { value: profile.voice, label: "已保存音色（可重新选择）" },
          ...preset.voices,
        ]
      : preset.voices
    : [];
  const saved = status?.profiles.find(
    (value) => value.provider === status.selected,
  );
  const savedPreset = status?.presets.find(
    (value) => value.provider === status.selected,
  );
  const ready = Boolean(
    saved?.url &&
    saved.model &&
    saved.voice &&
    (saved.key_configured || saved.provider === "custom"),
  );

  function stopPreview() {
    previewEpoch.current++;
    previewActive.current = false;
    player.current?.stop();
    if (mounted.current) setPreviewing(false);
  }
  async function load(edit: boolean) {
    loader.current?.abort();
    const controller = new AbortController();
    loader.current = controller;
    const own = ++loadEpoch.current;
    setLoading(true);
    setError("");
    try {
      const value = await api<TTSSettings>("/settings/tts", "GET", undefined, {
        signal: controller.signal,
        timeoutMs: 10000,
      });
      if (!Array.isArray(value.profiles) || !Array.isArray(value.presets))
        throw new Error("在线朗读配置返回异常，请重试。");
      if (mounted.current && own === loadEpoch.current) {
        setStatus(value);
        if (edit) setForm(value);
      }
    } catch (cause) {
      if (
        mounted.current &&
        own === loadEpoch.current &&
        !controller.signal.aborted
      )
        setError(
          errorMessage(cause) === "Not Found"
            ? "本机服务尚未加载在线朗读配置，请完全退出并重新启动测试版。"
            : errorMessage(cause),
        );
    } finally {
      if (mounted.current && own === loadEpoch.current) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void load(false);
    return () => {
      mounted.current = false;
      loader.current?.abort();
      stopPreview();
    };
  }, []);
  useEffect(() => {
    if (!active) {
      stopPreview();
      setOpen(false);
    }
  }, [active]);
  function configure() {
    stopPreview();
    setForm(undefined);
    setFields({});
    setNotice("");
    setOpen(true);
    void load(true);
  }
  const configureAction = useRef(configure);
  configureAction.current = configure;
  useEffect(() => {
    if (!configureRequested) {
      requestHandled.current = false;
      return;
    }
    if (!active || requestHandled.current) return;
    requestHandled.current = true;
    configureAction.current();
    onConfigureHandled?.();
  }, [active, configureRequested, onConfigureHandled]);

  function change(patch: Partial<TTSProfile>) {
    stopPreview();
    setError("");
    setNotice("");
    setFields({});
    setForm(
      (value) =>
        value && {
          ...value,
          profiles: value.profiles.map((row) =>
            row.provider === value.selected ? { ...row, ...patch } : row,
          ),
        },
    );
  }
  function close(value: boolean) {
    if (saveLock.current) return;
    stopPreview();
    setOpen(value);
    if (!value) {
      loader.current?.abort();
      ++loadEpoch.current;
      setForm(undefined);
      setError("");
      setFields({});
      setNotice("");
    }
  }
  function validate() {
    if (!profile) return false;
    const issues: Record<string, string> = {};
    try {
      const url = new URL(profile.url.trim());
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        issues.url = "请输入不含密钥和查询参数的 HTTP(S) 地址";
    } catch {
      issues.url = "请填写完整的接口地址";
    }
    if (!profile.model.trim()) issues.model = "请填写语音模型";
    if (!profile.voice.trim())
      issues.voice =
        profile.provider === "custom" ? "请填写音色 ID" : "请选择音色";
    setFields(issues);
    return !Object.keys(issues).length;
  }
  function payload(row: Editable["profiles"][number]): TTSProfile {
    return {
      provider: row.provider,
      url: row.url.trim(),
      model: row.model.trim(),
      voice: row.voice.trim(),
      credential_connection_id: row.credential_connection_id ?? null,
      api_key: row.api_key === "" ? "" : row.api_key?.trim() || null,
    };
  }
  async function save() {
    if (!form || !profile || saveLock.current || !validate()) return;
    stopPreview();
    saveLock.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const value = await api<TTSSettings>("/settings/tts", "PUT", {
        selected: form.selected,
        profiles: form.profiles.map(payload),
      });
      if (mounted.current) {
        setStatus(value);
        setForm(value);
        setNotice("在线朗读配置已保存");
      }
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      saveLock.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  async function preview() {
    if (previewActive.current) {
      stopPreview();
      return;
    }
    if (!profile || !validate()) return;
    if (
      profile.provider !== "custom" && !profile.credential_connection_id &&
      (profile.api_key === "" ||
        (!profile.key_configured && !profile.api_key?.trim()))
    ) {
      setFields((value) => ({
        ...value,
        api_key: "请填写此服务商的 TTS 密钥后试听",
      }));
      return;
    }
    if (!sample.trim()) {
      setFields((value) => ({ ...value, sample: "请输入试听文字" }));
      return;
    }
    const own = ++previewEpoch.current;
    previewActive.current = true;
    setPreviewing(true);
    setError("");
    setNotice("");
    try {
      await player.current!.play(sample, { profile: payload(profile) });
    } catch (cause) {
      if (mounted.current && own === previewEpoch.current)
        setError(errorMessage(cause));
    } finally {
      if (mounted.current && own === previewEpoch.current) {
        previewActive.current = false;
        setPreviewing(false);
      }
    }
  }
  return (
    <ConnectionCard
      title="语音朗读"
      description="在线 TTS · 朗读选中文字和译文"
      icon={Volume2}
      ready={ready}
      status={
        loading && !status
          ? "读取中"
          : error && !open
            ? "读取失败"
            : ready
              ? "已配置"
              : "未配置"
      }
      detail={
        error && !open
          ? "点击配置重试"
          : ready
            ? `${savedPreset?.label} · ${
                savedPreset?.voices.find(
                  (voice) => voice.value === saved!.voice,
                )?.label ||
                (saved!.provider === "custom" ? saved!.voice : "已保存音色")
              }`
            : "预置百炼、硅基流动和 MiniMax"
      }
      onConfigure={configure}
    >
      <Dialog open={open} onOpenChange={close}>
        <DialogContent
          className="connection-config-dialog tts-dialog"
          showCloseButton={!saving}
        >
          <DialogHeader>
            <DialogTitle>语音朗读</DialogTitle>
            <DialogDescription>
              文字发送到所选 TTS
              服务生成语音，按该服务计费。音频只在内存中临时播放，不下载语音模型。
            </DialogDescription>
          </DialogHeader>
          {loading ? (
            <p role="status">
              <Loader2 size={16} className="spin" />
              正在读取朗读配置…
            </p>
          ) : form && profile && preset ? (
            <div className="tts-form">
              <div className="form-field">
                <Label htmlFor="tts-provider">朗读服务</Label>
                <SoftSelect
                  id="tts-provider"
                  label="朗读服务"
                  value={form.selected}
                  disabled={saving}
                  options={form.presets.map((value) => ({
                    value: value.provider,
                    label: value.label,
                  }))}
                  onValueChange={(value) => {
                    stopPreview();
                    setFields({});
                    setError("");
                    setNotice("");
                    setForm(
                      (old) =>
                        old && {
                          ...old,
                          selected: value as TTSSettings["selected"],
                        },
                    );
                  }}
                />
                <p className="tts-help">{preset.description}</p>
              </div>
              <div className="form-field">
                <Label htmlFor="tts-url">接口地址</Label>
                <Input
                  id="tts-url"
                  value={profile.url}
                  disabled={saving}
                  maxLength={2048}
                  placeholder="https://example.com/v1/audio/speech"
                  aria-invalid={Boolean(fields.url)}
                  aria-describedby={fields.url ? "tts-url-error" : undefined}
                  onChange={(event) => change({ url: event.target.value })}
                />
                {fields.url && (
                  <p id="tts-url-error" className="field-error">
                    {fields.url}
                  </p>
                )}
              </div>
              <div className="form-field">
                <Label htmlFor="tts-model">语音模型</Label>
                <Input
                  id="tts-model"
                  value={profile.model}
                  disabled={saving}
                  maxLength={200}
                  aria-invalid={Boolean(fields.model)}
                  onChange={(event) => change({ model: event.target.value })}
                />
                {preset.models.length > 1 && (
                  <div className="tts-model-presets">
                    {preset.models.map((model) => (
                      <Button
                        key={model}
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={saving}
                        onClick={() => change({ model })}
                      >
                        {model}
                      </Button>
                    ))}
                  </div>
                )}
                {fields.model && <p className="field-error">{fields.model}</p>}
              </div>
              <div className="form-field">
                <Label htmlFor="tts-voice">
                  {profile.provider === "custom" ? "音色 ID" : "音色"}
                </Label>
                {profile.provider !== "custom" ? (
                  <SoftSelect
                    id="tts-voice"
                    label="音色"
                    value={profile.voice}
                    placeholder="选择音色"
                    disabled={saving}
                    options={voiceOptions}
                    onValueChange={(voice) => change({ voice })}
                  />
                ) : (
                  <Input
                    id="tts-voice"
                    value={profile.voice}
                    disabled={saving}
                    maxLength={300}
                    aria-invalid={Boolean(fields.voice)}
                    placeholder="输入自定义接口提供的音色 ID"
                    onChange={(event) => change({ voice: event.target.value })}
                  />
                )}
                {fields.voice && <p className="field-error">{fields.voice}</p>}
              </div>
              <SharedCredentialSource connectionId={profile.credential_connection_id} url={profile.url} disabled={saving}
                onChange={(id) => change({ credential_connection_id: id, api_key: null })} />
              {!profile.credential_connection_id && <div className="form-field">
                <div className="tts-secret-heading">
                  <Label htmlFor="tts-key">API 密钥</Label>
                  {profile.key_configured && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      data-delete-action={profile.api_key === "" ? undefined : true}
                      disabled={saving}
                      onClick={() =>
                        change({ api_key: profile.api_key === "" ? null : "" })
                      }
                    >
                      {profile.api_key === "" && <Undo2 size={13} />}
                      {profile.api_key === "" ? "撤销清除" : "清除密钥"}
                    </Button>
                  )}
                </div>
                <Input
                  id="tts-key"
                  type="password"
                  autoComplete="new-password"
                  value={profile.api_key || ""}
                  disabled={saving}
                  aria-invalid={Boolean(fields.api_key)}
                  aria-describedby={
                    fields.api_key ? "tts-key-error" : undefined
                  }
                  placeholder={
                    profile.api_key === ""
                      ? "保存后清除密钥"
                      : profile.key_configured
                        ? "密钥已保存，留空保持不变"
                        : "输入 TTS 服务密钥"
                  }
                  onChange={(event) =>
                    change({ api_key: event.target.value || null })
                  }
                />
                {fields.api_key && (
                  <p id="tts-key-error" className="field-error">
                    {fields.api_key}
                  </p>
                )}
              </div>}
              <div className="tts-preset-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={() =>
                    change({
                      url: preset.url,
                      model: preset.model,
                      voice: preset.voice,
                    })
                  }
                >
                  恢复服务商预设
                </Button>
                {preset.docs_url && (
                  <a
                    href={preset.docs_url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => {
                      if (isTauri()) {
                        event.preventDefault();
                        void invoke("open_external_url", {
                          url: preset.docs_url,
                        }).catch((cause) => setError(errorMessage(cause)));
                      }
                    }}
                  >
                    查看服务商音色文档
                    <ExternalLink size={13} />
                  </a>
                )}
              </div>
              <div className="form-field">
                <Label htmlFor="tts-sample">试听文字</Label>
                <Textarea
                  id="tts-sample"
                  rows={2}
                  maxLength={240}
                  value={sample}
                  disabled={saving}
                  aria-invalid={Boolean(fields.sample)}
                  onChange={(event) => {
                    stopPreview();
                    setSample(event.target.value);
                    setFields({});
                  }}
                />
                {fields.sample && (
                  <p className="field-error">{fields.sample}</p>
                )}
                <p className="tts-help">
                  试听使用当前填写的配置，保存后用于划词朗读。输出为 AI
                  合成语音。
                </p>
              </div>
            </div>
          ) : null}
          {error && (
            <ErrorNotice
              message={error}
              retry={!form && !loading ? () => void load(true) : undefined}
            />
          )}
          <DialogFooter className="tts-footer">
            <span role="status">{notice}</span>
            <Button
              type="button"
              variant="outline"
              disabled={saving || loading || !profile}
              onClick={() => void preview()}
            >
              {previewing ? <Square size={14} /> : <Volume2 size={14} />}
              {previewing ? "停止试听" : "试听"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => close(false)}
            >
              关闭
            </Button>
            <Button
              type="button"
              disabled={saving || loading || !form}
              onClick={() => void save()}
            >
              {saving && <Loader2 className="spin" size={14} />}保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConnectionCard>
  );
}
