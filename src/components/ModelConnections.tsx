import { Hint } from "./common";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Download,
  Check,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { DropdownMenu, ToggleGroup } from "radix-ui";
import { api, fetchApi, type Settings } from "@/lib/api";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { SoftSelect } from "./ui/soft-select";
import { ContextCapacityInput } from "./ContextCapacityInput";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { ConfirmDelete, ErrorNotice, Toast } from "./common";
import { errorMessage } from "@/lib/utils";
import { effortOptions } from "@/lib/reasoningEffort";
import { ChatIcon, ConnectionIcon } from "./SoftIcons";
import { QuickModelSetup } from "./QuickModelSetup";

type Connection = Settings["providers"][number];
type Draft = Connection & { api_key?: string | null };
export type ModelContextTarget = { providerId: string; modelName: string };
const thinkingOptions = [
  { value: "auto", label: "自动识别" },
  { value: "none", label: "不支持思考" },
  { value: "always", label: "始终思考" },
  { value: "enable_thinking", label: "enable_thinking 开关" },
  { value: "thinking", label: "thinking.type 开关" },
  { value: "reasoning_effort", label: "reasoning_effort 强度" },
];
const thinkingControlLabels: Record<string, string> = {
  auto: "保存后识别",
  none: "未检测到思考开关",
  always: "始终思考",
  enable_thinking: "enable_thinking 开关",
  thinking: "thinking 开关",
  reasoning_effort: "reasoning_effort 强度",
};
const blankModel = () => ({
  name: "",
  context_tokens: 500000,
  vision_enabled: false,
  thinking_mode: "auto" as const,
  thinking_control: "auto" as const,
  default_thinking_enabled: false,
});

function modelThinkingControl(model: Connection["models"][number]) {
  return model.thinking_mode && model.thinking_mode !== "auto"
    ? model.thinking_mode
    : model.thinking_control;
}

export function ModelConnections({
  settings,
  onSaved,
  onQuickSaved,
  contextTarget,
  onContextTargetHandled,
  onOpenServices,
}: {
  settings: Settings;
  onSaved: (value: Settings) => void;
  onQuickSaved?: (value: Settings) => void;
  contextTarget?: ModelContextTarget;
  onContextTargetHandled?: () => void;
  onOpenServices?: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [contextFocusModel, setContextFocusModel] = useState<string>();
  const contextInput = useRef<HTMLInputElement | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState<Connection | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalog, setCatalog] = useState<Connection["models"]>([]);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [modelQuery, setModelQuery] = useState("");
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const errorAction = onOpenServices && error.includes("请先在能力连接中更换密钥来源")
    ? {
        label: "前往能力连接",
        onClick: () => {
          setDeleting(null);
          setDraft(null);
          setError("");
          onOpenServices();
        },
      }
    : undefined;
  const catalogRequest = useRef<AbortController | null>(null);
  useEffect(() => () => catalogRequest.current?.abort(), []);
  const connections = settings.providers;
  const presets = settings.provider_presets;
  const defaultConnection = connections.find(
    (x) => x.id === settings.default_provider,
  );
  const defaultKey = defaultConnection?.default_model
    ? `${defaultConnection.id}:${defaultConnection.default_model}`
    : "";
  const options = connections.flatMap((connection) =>
    connection.models.map((model) => ({
      value: `${connection.id}:${model.name}`,
      label: `${connection.label} · ${model.name}`,
    })),
  );
  function uniqueLabel(label: string) {
    let name = label,
      i = 2;
    while (connections.some((x) => x.label === name)) name = `${label} ${i++}`;
    return name;
  }
  function add() {
    setContextFocusModel(undefined);
    const preset = presets[0];
    setIsNew(true);
    setError("");
    setNotice("");
    setDraft({
      id: `conn_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
      provider_type: preset.id,
      label: uniqueLabel(preset.label),
      model_url: preset.model_url,
      default_model: preset.models[0]?.name || "",
      key_configured: false,
      models: preset.models.length
        ? preset.models.map((x) => ({ ...blankModel(), ...x }))
        : [blankModel()],
    });
  }
  const edit = useCallback((value: Connection, modelName?: string) => {
    setContextFocusModel(modelName);
    setIsNew(false);
    setError("");
    setNotice("");
    setDraft({
      ...value,
      models: value.models.length
        ? value.models.map((x) => ({ ...x }))
        : [blankModel()],
    });
  }, []);
  useEffect(() => {
    if (!contextTarget) return;
    const connection = settings.providers.find((value) => value.id === contextTarget.providerId);
    if (connection?.models.some((model) => model.name === contextTarget.modelName)) {
      edit(connection, contextTarget.modelName);
    } else {
      setError("当前模型连接已变更，请在连接列表中重新选择。");
    }
    onContextTargetHandled?.();
  }, [contextTarget, settings.providers, edit, onContextTargetHandled]);
  function switchPreset(id: string) {
    if (!draft) return;
    const preset = presets.find((x) => x.id === id)!;
    setDraft({
      ...draft,
      provider_type: preset.id,
      label: uniqueLabel(preset.label),
      model_url: preset.model_url,
      api_key: null,
      key_configured: false,
      models: preset.models.length
        ? preset.models.map((x) => ({ ...blankModel(), ...x }))
        : [blankModel()],
      default_model: preset.models[0]?.name || "",
    });
  }
  function updateModel(index: number, patch: Partial<Draft["models"][number]>) {
    if (!draft) return;
    const models = draft.models.map((x, i) =>
      i === index
        ? {
            ...x,
            ...patch,
            ...(patch.name !== undefined
              ? { thinking_control: "auto" as const, reasoning_efforts: null, default_reasoning_effort: null }
              : {}),
            ...(patch.thinking_mode !== undefined
              ? { reasoning_efforts: null, default_reasoning_effort: null }
              : {}),
          }
        : x,
    );
    setDraft({
      ...draft,
      models,
      default_model:
        draft.models[index].name === draft.default_model &&
        patch.name !== undefined
          ? patch.name
          : draft.default_model,
    });
  }
  function closeCatalog() {
    catalogRequest.current?.abort();
    catalogRequest.current = null;
    setCatalogBusy(false);
    setCatalogOpen(false);
  }
  async function fetchModels() {
    if (!draft) return;
    catalogRequest.current?.abort();
    const request = new AbortController();
    catalogRequest.current = request;
    setCatalogOpen(true);
    setCatalogBusy(true);
    setCatalogError("");
    setCatalog([]);
    setModelQuery("");
    setSelectedModels(new Set());
    try {
      const response = await fetchApi("/settings/providers/models", {
        method: "POST",
        signal: request.signal,
        body: JSON.stringify({
          id: draft.id,
          provider_type: draft.provider_type,
          label: draft.label,
          model_url: draft.model_url,
          api_key: draft.api_key ?? null,
          models: [],
          default_model: "",
        }),
      });
      const models: Connection["models"] = await response.json();
      if (!request.signal.aborted) setCatalog(models);
    } catch (error) {
      if (!request.signal.aborted) setCatalogError(errorMessage(error));
    } finally {
      if (catalogRequest.current === request) setCatalogBusy(false);
    }
  }
  function addSelectedModels() {
    if (!draft) return;
    const existing = draft.models.filter((model) => model.name.trim());
    const names = new Set(existing.map((model) => model.name.trim()));
    const added = catalog.filter(
      (model) => selectedModels.has(model.name) && !names.has(model.name),
    );
    if (existing.length + added.length > 50) {
      setCatalogError("每个连接最多保存 50 个模型，请减少选择后再添加。");
      return;
    }
    const models = [...existing, ...added];
    setDraft({
      ...draft,
      models,
      default_model: names.has(draft.default_model)
        ? draft.default_model
        : models[0]?.name || "",
    });
    closeCatalog();
    setNotice(`已加入 ${added.length} 个模型，保存连接后生效。`);
  }
  const existingModelNames = new Set(
    draft?.models.map((model) => model.name.trim()) || [],
  );
  const visibleModels = catalog.filter((model) =>
    model.name.toLowerCase().includes(modelQuery.trim().toLowerCase()),
  );
  async function save(test = false) {
    if (!draft) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!draft.label.trim()) throw new Error("请填写连接名称。");
      const models = draft.models
        .filter((x) => x.name.trim())
        .map((x) => ({ ...x, name: x.name.trim() }));
      if (!models.length) throw new Error("请添加至少一个模型。");
      if (
        models.some(
          (model) =>
            !Number.isInteger(model.context_tokens ?? 500000) ||
            (model.context_tokens ?? 500000) < 4096 ||
            (model.context_tokens ?? 500000) > 2000000,
        )
      )
        throw new Error("请调整标记的上下文容量，有效范围为 4.096–2,000k token。");
      if (new Set(models.map((x) => x.name)).size !== models.length)
        throw new Error("模型名称不能重复。");
      const profile = {
        id: draft.id,
        provider_type: draft.provider_type,
        label: draft.label.trim(),
        model_url: draft.model_url,
        models,
        default_model: models.some((x) => x.name === draft.default_model.trim())
          ? draft.default_model.trim()
          : models[0].name,
        api_key: draft.api_key ?? null,
      };
      const value = await api<Settings>("/settings", "PUT", {
        providers: [profile],
        timezone: settings.timezone,
      });
      onSaved(value);
      if (test) {
        setDraft(value.providers.find((x) => x.id === draft.id)!);
        setIsNew(false);
        const result = await api<{ message: string }>(
          "/settings/test",
          "POST",
          {
            provider_id: draft.id,
            model_name: profile.default_model,
            thinking_enabled: false,
          },
        );
        setNotice(result.message);
      } else {
        setDraft(null);
        setNotice("连接已保存");
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function chooseDefault(key: string) {
    const split = key.indexOf(":"),
      id = key.slice(0, split),
      model = key.slice(split + 1);
    const connection = connections.find((x) => x.id === id)!;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      onSaved(
        await api<Settings>("/settings", "PUT", {
          providers: [{ ...connection, default_model: model }],
          default_provider: id,
          timezone: settings.timezone,
        }),
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api<Settings & { affected_capabilities: string[] }>(`/settings/providers/${deleting.id}`, "DELETE");
      onSaved(saved);
      setNotice(saved.affected_capabilities.length
        ? `连接已删除，${saved.affected_capabilities.join("、")}的共享密钥来源已移除，请重新配置。`
        : "连接已删除");
      setDeleting(null);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section model-connections model-hub">
      <div className="connections-heading">
        <div>
          <span className="model-hub-eyebrow">对话与推理</span>
          <h2>模型连接</h2>
          <p>
            可快速配置常用能力，也可手动添加接口和模型。
          </p>
        </div>
        <Button className="model-add-button" onClick={add} disabled={busy}>
          <Plus size={15} />
          手动添加连接
        </Button>
      </div>
      <QuickModelSetup onSaved={onQuickSaved || onSaved} />
      {!draft && notice && (
        <Toast message={notice} onClose={() => setNotice("")} />
      )}
      {!draft && error && (
        <Toast
          tone="error"
          message={error}
          onClose={() => setError("")}
          action={errorAction && (
            <Button type="button" variant="link" size="sm" onClick={errorAction.onClick}>
              {errorAction.label}
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Button>
          )}
        />
      )}
      {options.length > 0 && (
        <div className="model-default-panel">
          <span className="model-default-icon" aria-hidden="true">
            <ChatIcon size={18} />
          </span>
          <div className="model-default-copy">
            <span>当前默认</span>
            <strong>
              {defaultConnection?.label || "尚未选择连接"}
              <small>{defaultConnection?.default_model}</small>
            </strong>
            <p>新对话、学习和计划整理会优先使用这个模型。</p>
          </div>
          <div className="model-default-control">
            <Label htmlFor="default-model">默认模型</Label>
            <SoftSelect
              id="default-model"
              label="默认模型"
              value={defaultKey}
              disabled={busy}
              onValueChange={(v) => void chooseDefault(v)}
              options={options}
            />
          </div>
        </div>
      )}
      <div className="connection-list model-provider-list">
        {connections.map((connection) => {
          const ready = Boolean(
            connection.key_configured && connection.models.length,
          );
          const preset = presets.find(
            (item) => item.id === connection.provider_type,
          );
          return (
            <article
              className="connection-card model-provider-card"
              data-default={settings.default_provider === connection.id}
              key={connection.id}
            >
              <div className="model-provider-heading">
                <span className="connection-symbol">
                  <ConnectionIcon size={17} />
                </span>
                <div className="connection-card-copy">
                  <div className="connection-card-title">
                    <strong>{connection.label}</strong>
                    {settings.default_provider === connection.id && (
                      <small className="default-badge">默认</small>
                    )}
                  </div>
                  <span className="connection-card-meta">
                    {preset?.label || "自定义接口"}
                    <span aria-hidden="true"> · </span>
                    {connection.models.length} 个模型
                  </span>
                </div>
                <span className={`connection-state ${ready ? "ready" : ""}`}>
                  <i />
                  {ready ? "已配置" : "待完善"}
                </span>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      className="icon-button"
                      aria-label={`${connection.label} 更多操作`}
                    >
                      <MoreHorizontal size={18} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="model-menu"
                      align="end"
                      sideOffset={5}
                    >
                      <DropdownMenu.Item
                        className="model-menu-item"
                        onSelect={() => edit(connection)}
                      >
                        <Pencil size={14} />
                        编辑连接
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className="model-menu-item danger"
                        data-delete-action
                        onSelect={() => setDeleting(connection)}
                      >
                        <Trash2 size={14} />
                        删除连接
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
              <div className="model-provider-models" aria-label="模型列表">
                {connection.models.length ? (
                  connection.models.map((model) => (
                    <span
                      className="model-pill"
                      data-default={
                        connection.default_model === model.name &&
                        settings.default_provider === connection.id
                      }
                      key={model.name}
                    >
                      {model.name}
                      {connection.default_model === model.name &&
                        settings.default_provider === connection.id && (
                          <Check size={11} />
                        )}
                    </span>
                  ))
                ) : (
                  <span className="model-pill is-empty">还没有模型</span>
                )}
              </div>
              <div className="model-provider-footer">
                <span>
                  {connection.key_configured ? (
                    <ShieldCheck size={13} />
                  ) : (
                    <KeyRound size={13} />
                  )}
                  {connection.key_configured
                    ? "密钥已安全保存"
                    : "还需要填写 API 密钥"}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`编辑连接 ${connection.label}`}
                  onClick={() => edit(connection)}
                >
                  <Pencil size={13} />
                  编辑连接
                </Button>
              </div>
            </article>
          );
        })}
      </div>
      {connections.length === 0 && (
        <button className="connection-empty" onClick={add}>
          <span className="connection-symbol">
            <ConnectionIcon size={20} />
          </span>
          <strong>添加第一个模型连接</strong>
          <span>阿里云百炼、DeepSeek、Kimi、智谱、硅基流动或自定义接口</span>
        </button>
      )}
      <Dialog
        open={Boolean(draft)}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setDraft(null);
            setError("");
            setNotice("");
          }
        }}
      >
        <DialogContent
          className="model-dialog model-dialog-redesign"
          onOpenAutoFocus={(event) => {
            if (!contextInput.current) return;
            event.preventDefault();
            contextInput.current.focus({ preventScroll: true });
            contextInput.current.scrollIntoView({ block: "center" });
          }}
        >
          <DialogHeader className="model-dialog-heading">
            <span className="model-dialog-icon" aria-hidden="true">
              {isNew ? <Server size={19} /> : <ConnectionIcon size={19} />}
            </span>
            <span>
              <DialogTitle>
                {isNew ? "添加模型连接" : "编辑模型连接"}
              </DialogTitle>
              <DialogDescription>
                {isNew
                  ? "按服务商整理接口与模型，之后可以随时切换默认模型。"
                  : "修改接口、密钥或这个连接下的模型。"}
              </DialogDescription>
            </span>
          </DialogHeader>
          {draft && (
            <>
              <div className="model-dialog-body">
                <section className="model-dialog-section">
                  <div className="model-dialog-section-title">
                    <span>1</span>
                    <div>
                      <h3>选择服务商</h3>
                      <p>预设会自动填好常用接口和模型名称。</p>
                    </div>
                  </div>
                  <div
                    className="provider-preset-grid"
                    role="group"
                    aria-label="服务商"
                  >
                    {presets.map((preset) => (
                      <button
                        type="button"
                        key={preset.id}
                        aria-pressed={draft.provider_type === preset.id}
                        disabled={busy || !isNew}
                        onClick={() => switchPreset(preset.id)}
                      >
                        <span>{preset.label}</span>
                        <small>
                          {(() => {
                            try {
                              return new URL(preset.model_url).hostname;
                            } catch {
                              return preset.model_url || "自定义地址";
                            }
                          })()}
                        </small>
                        {draft.provider_type === preset.id && (
                          <Check size={14} />
                        )}
                      </button>
                    ))}
                  </div>
                </section>
                <section className="model-dialog-section">
                  <div className="model-dialog-section-title">
                    <span>2</span>
                    <div>
                      <h3>接口与凭据</h3>
                      <p>这些配置只属于当前连接，不会影响其他模型。</p>
                    </div>
                  </div>
                  <div className="connection-form-grid">
                    <div className="form-field">
                      <Label htmlFor="connection-name">连接名称</Label>
                      <Input
                        id="connection-name"
                        value={draft.label}
                        disabled={busy}
                        onChange={(e) =>
                          setDraft({ ...draft, label: e.target.value })
                        }
                        placeholder="例如：工作用 DeepSeek"
                      />
                    </div>
                    <div className="form-field">
                      <Label htmlFor="model-url">接口地址</Label>
                      <Input
                        id="model-url"
                        value={draft.model_url}
                        disabled={busy}
                        onChange={(e) =>
                          setDraft({ ...draft, model_url: e.target.value })
                        }
                        placeholder="https://example.com/v1"
                      />
                    </div>
                  </div>
                  <div className="form-field">
                    <div className="embedding-label-row">
                      <Label htmlFor="model-key">
                        <KeyRound size={13} />
                        API 密钥
                      </Label>
                      {draft.key_configured && (
                        <button
                          type="button"
                          className={`embedding-secret-action ${draft.api_key === "" ? "is-clearing" : ""}`}
                          data-delete-action={draft.api_key === "" ? undefined : true}
                          disabled={busy}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              api_key: draft.api_key === "" ? undefined : "",
                            })
                          }
                        >
                          {draft.api_key === "" ? "撤销清除" : "清除密钥"}
                        </button>
                      )}
                    </div>
                    <Input
                      id="model-key"
                      type="password"
                      autoComplete="new-password"
                      value={draft.api_key || ""}
                      disabled={busy}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          api_key: e.target.value || null,
                        })
                      }
                      placeholder={
                        draft.api_key === ""
                          ? "保存后将移除已存密钥"
                          : draft.key_configured
                            ? "密钥已保存，留空保持不变"
                            : "输入 API 密钥"
                      }
                    />
                  </div>
                </section>
                <section className="model-dialog-section connection-model-section">
                  <div className="model-dialog-section-title">
                    <span>3</span>
                    <div>
                      <h3>模型</h3>
                      <p>一个连接可以有多个模型，分别设置能力与思考方式。</p>
                    </div>
                  </div>
                  <div className="models-heading">
                    <span>模型列表</span>
                    <div className="model-list-actions">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void fetchModels()}
                      >
                        <Download size={14} />
                        拉取模型
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            models: [...draft.models, blankModel()],
                          })
                        }
                      >
                        <Plus size={14} />
                        添加模型
                      </Button>
                    </div>
                  </div>
                  <div className="model-editor-list">
                    {draft.models.map((model, index) => (
                      <div className="connection-model-row" key={index}>
                        <div className="model-name-row">
                          <Input
                            aria-label={
                              index === 0 ? "模型名称" : `模型名称 ${index + 1}`
                            }
                            value={model.name}
                            disabled={busy}
                            placeholder="模型名称"
                            onChange={(e) =>
                              updateModel(index, { name: e.target.value })
                            }
                          />
                          <button
                            className="icon-button"
                            data-delete-action
                            aria-label={`移除模型 ${index + 1}`}
                            disabled={busy}
                            onClick={() => {
                              const models = draft.models.filter(
                                (_, i) => i !== index,
                              );
                              setDraft({
                                ...draft,
                                models,
                                default_model:
                                  draft.default_model === model.name
                                    ? models[0]?.name || ""
                                    : draft.default_model,
                              });
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                        <div className="model-capabilities">
                          <div className="model-option-row model-context-setting">
                            <span className="model-option-copy">
                              <strong>上下文大小</strong>
                              <small>同时参考的聊天与资料量</small>
                            </span>
                            <ContextCapacityInput
                                inputRef={model.name === contextFocusModel ? contextInput : undefined}
                                label={`模型 ${index + 1} 上下文大小`}
                                value={model.context_tokens ?? 500000}
                                disabled={busy}
                                onChange={(context_tokens) => updateModel(index, { context_tokens })}
                              />
                          </div>
                          <label className="model-option-row model-vision">
                            <span className="model-option-copy">
                              <strong>图片输入</strong>
                              <small>理解截图和照片；生成图片需独立图片模型</small>
                            </span>
                            <Checkbox
                              aria-label={`模型 ${index + 1} 图片输入`}
                              checked={model.vision_enabled}
                              disabled={busy}
                              onCheckedChange={(v) =>
                                updateModel(index, {
                                  vision_enabled: v === true,
                                })
                              }
                            />
                          </label>
                          <div className="model-option-row model-thinking-control">
                            <span className="model-option-copy">
                              <strong>思考支持</strong>
                              <small>按服务商与完整模型名自动判断</small>
                            </span>
                            <span className="model-thinking-select">
                              <SoftSelect
                                label={`模型 ${index + 1} 思考配置`}
                                value={model.thinking_mode || "auto"}
                                disabled={busy}
                                onValueChange={(v) =>
                                  updateModel(index, {
                                    thinking_mode:
                                      v as typeof model.thinking_mode,
                                  })
                                }
                                options={thinkingOptions}
                              />
                              {model.thinking_mode === "auto" && (
                                <Hint label="识别依据是当前服务商接口和完整模型名，不使用默认模型代替。">
                                  <small
                                    className="model-thinking-detected"
                                    tabIndex={0}
                                  >
                                    {model.thinking_control &&
                                    model.thinking_control !== "auto"
                                      ? `自动识别：${thinkingControlLabels[model.thinking_control]}`
                                      : "保存后按当前模型精确识别"}
                                  </small>
                                </Hint>
                              )}
                            </span>
                          </div>
                          <div className="model-option-row model-thinking-enabled">
                            <span className="model-option-copy">
                              <strong>启用思考</strong>
                              <small>
                                {modelThinkingControl(model) === "always"
                                  ? "此模型始终思考，无法关闭"
                                  : modelThinkingControl(model) === "none"
                                    ? "当前模型不支持思考，请先核对思考支持配置"
                                    : "聊天使用此模型时，沿用这里的开关与下方强度"}
                              </small>
                            </span>
                            <label className="module-toggle model-thinking-switch">
                              <span>
                                {modelThinkingControl(model) === "always"
                                  ? "始终开启"
                                  : modelThinkingControl(model) !== "none" &&
                                      model.default_thinking_enabled
                                    ? "已开启"
                                    : "已关闭"}
                              </span>
                              <input
                                type="checkbox"
                                role="switch"
                                aria-label={`模型 ${index + 1} 启用思考`}
                                checked={
                                  modelThinkingControl(model) === "always" ||
                                  (modelThinkingControl(model) !== "none" &&
                                    Boolean(model.default_thinking_enabled))
                                }
                                disabled={
                                  busy ||
                                  ["none", "always"].includes(modelThinkingControl(model))
                                }
                                onChange={(event) =>
                                  updateModel(index, {
                                    default_thinking_enabled: event.target.checked,
                                  })
                                }
                              />
                            </label>
                          </div>
                        </div>
                        {(model.thinking_mode === "reasoning_effort" || Boolean(model.reasoning_efforts?.length)) && (
                          <div className="model-effort-settings">
                            <div className="model-effort-heading">
                              <strong>思考强度</strong>
                              <p>
                                勾选接口支持的档位，再选择聊天时默认使用的强度。
                              </p>
                            </div>
                            <div className="model-effort-row">
                              <span>
                                可用档位<small>至少保留一档</small>
                              </span>
                              <ToggleGroup.Root
                                type="multiple"
                                className="model-effort-levels"
                                aria-label={`模型 ${index + 1} 支持的思考强度`}
                                value={model.reasoning_efforts ?? ["low", "medium", "high"]}
                                disabled={busy}
                                onValueChange={(values) => {
                                  if (!values.length) return;
                                  updateModel(index, {
                                    reasoning_efforts: effortOptions
                                      .filter((option) => values.includes(option.value))
                                      .map((option) => option.value),
                                    default_reasoning_effort: values.includes(
                                      model.default_reasoning_effort || "",
                                    ) ? model.default_reasoning_effort : null,
                                  });
                                }}
                              >
                                {effortOptions.map((option) => {
                                  const levels = model.reasoning_efforts ?? ["low", "medium", "high"];
                                  return (
                                    <ToggleGroup.Item
                                      key={option.value}
                                      value={option.value}
                                      disabled={
                                        busy ||
                                        (levels.length === 1 && levels.includes(option.value))
                                      }
                                      aria-label={`模型 ${index + 1} 支持${option.label}强度`}
                                    >
                                      <Check size={13} aria-hidden="true" />
                                      {option.label}
                                    </ToggleGroup.Item>
                                  );
                                })}
                              </ToggleGroup.Root>
                            </div>
                            <div className="model-effort-row">
                              <span>
                                默认强度<small>未单独选择时使用</small>
                              </span>
                              <SoftSelect
                                className="model-effort-default"
                                label={`模型 ${index + 1} 默认思考强度`}
                                value={model.default_reasoning_effort || "auto"}
                                disabled={busy}
                                onValueChange={(value) =>
                                  updateModel(index, {
                                    default_reasoning_effort: value === "auto"
                                      ? null
                                      : value as typeof model.default_reasoning_effort,
                                  })
                                }
                                options={[
                                  { value: "auto", label: "服务商默认" },
                                  ...effortOptions.filter((option) =>
                                    (model.reasoning_efforts ?? ["low", "medium", "high"])
                                      .includes(option.value),
                                  ),
                                ]}
                              />
                            </div>
                          </div>
                        )}
                        <p className="model-capabilities-note">
                          上下文包含提示、历史、工具结果与回复预留；调大数值不会扩展模型本身的能力。
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
              <div className="model-dialog-status">
                {error && <ErrorNotice message={error} action={errorAction} />}
                {notice && (
                  <p className="connection-notice" role="status">
                    <Check size={14} />
                    {notice}
                  </p>
                )}
              </div>
              <DialogFooter className="model-dialog-footer">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void save(true)}
                >
                  保存并测试
                </Button>
                <Button disabled={busy} onClick={() => void save()}>
                  {busy && <Loader2 size={15} className="spin" />}
                  保存连接
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={catalogOpen}
        onOpenChange={(open) => {
          if (!open) closeCatalog();
        }}
      >
        <DialogContent className="model-catalog-dialog">
          <DialogHeader>
            <DialogTitle>选择要添加的模型</DialogTitle>
            <DialogDescription>
              {draft?.label || "当前连接"} ·
              选择模型并按需勾选图片输入，保存连接后生效。
            </DialogDescription>
          </DialogHeader>
          {catalogBusy ? (
            <p className="model-catalog-status" role="status">
              <Loader2 size={18} className="spin" />
              正在拉取模型…
            </p>
          ) : (
            <>
              {catalogError && <ErrorNotice message={catalogError} />}
              {catalog.length > 0 ? (
                <>
                  <Input
                    aria-label="搜索拉取到的模型"
                    placeholder="搜索模型名称…"
                    value={modelQuery}
                    onChange={(event) => setModelQuery(event.target.value)}
                  />
                  <div className="model-catalog-toolbar">
                    <span>
                      共 {catalog.length} 个模型 · 已选择 {selectedModels.size}{" "}
                      个
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const available = visibleModels.filter(
                          (model) => !existingModelNames.has(model.name),
                        );
                        const allSelected = available.every((model) =>
                          selectedModels.has(model.name),
                        );
                        setSelectedModels((current) => {
                          const next = new Set(current);
                          for (const model of available) {
                            if (allSelected) next.delete(model.name);
                            else next.add(model.name);
                          }
                          return next;
                        });
                      }}
                    >
                      选择 / 取消当前结果
                    </Button>
                  </div>
                  <div className="model-catalog-list">
                    {visibleModels.map((model) => {
                      const added = existingModelNames.has(model.name);
                      return (
                        <div className="model-catalog-row" key={model.name}>
                          <label className="model-catalog-name">
                            <Checkbox
                              checked={added || selectedModels.has(model.name)}
                              disabled={added}
                              onCheckedChange={(checked) =>
                                setSelectedModels((current) => {
                                  const next = new Set(current);
                                  if (checked === true) next.add(model.name);
                                  else next.delete(model.name);
                                  return next;
                                })
                              }
                            />
                            <span>
                              {model.name}
                              {added && <small>已添加</small>}
                            </span>
                          </label>
                          <label className="model-catalog-vision">
                            <Checkbox
                              disabled={added}
                              checked={
                                added
                                  ? draft?.models.find(
                                      (item) => item.name.trim() === model.name,
                                    )?.vision_enabled
                                  : model.vision_enabled
                              }
                              onCheckedChange={(checked) =>
                                setCatalog((models) =>
                                  models.map((item) =>
                                    item.name === model.name
                                      ? {
                                          ...item,
                                          vision_enabled: checked === true,
                                        }
                                      : item,
                                  ),
                                )
                              }
                            />
                            图片输入
                          </label>
                        </div>
                      );
                    })}
                    {!visibleModels.length && (
                      <p className="model-catalog-status">没有匹配的模型。</p>
                    )}
                  </div>
                  <p className="model-catalog-help">
                    图片输入能力请按服务商说明选择，模型列表未提供的能力不会自动勾选。
                  </p>
                </>
              ) : (
                !catalogError && (
                  <p className="model-catalog-status">
                    接口未返回可用模型，可返回手动添加。
                  </p>
                )
              )}
            </>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeCatalog}>
              取消
            </Button>
            {catalogError && (
              <Button
                variant="outline"
                disabled={catalogBusy}
                onClick={() => void fetchModels()}
              >
                重新拉取
              </Button>
            )}
            <Button
              disabled={catalogBusy || !selectedModels.size}
              onClick={addSelectedModels}
            >
              添加所选模型（{selectedModels.size}）
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDelete
        open={Boolean(deleting)}
        onClose={() => {
          setDeleting(null);
          setError("");
        }}
        label="删除连接"
        error={error}
        errorAction={errorAction}
        title={`删除 ${deleting?.label || "连接"}？`}
        description="这套连接的接口配置和已保存的密钥将一并移除。"
        onConfirm={remove}
      />
    </section>
  );
}
