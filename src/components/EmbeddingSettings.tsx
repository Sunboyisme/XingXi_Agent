import { useEffect, useRef, useState } from "react";
import {
  Boxes,
  CheckCircle2,
  KeyRound,
  Link2,
  Loader2,
  SearchCheck,
  Undo2,
} from "lucide-react";
import { api } from "@/lib/api";
import type { components } from "@/lib/api.generated";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorNotice } from "./common";
import { ConnectionCard } from "./ConnectionCard";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { errorMessage } from "@/lib/utils";

type Status = components["schemas"]["EmbeddingRead"];
const initial: Status = {
  enabled: false,
  url: "https://api.openai.com/v1",
  model: "",
  key_configured: false,
  indexed: 0,
  total: 0,
  indexing: false,
  error: "",
};
export function EmbeddingSettings() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>(initial);
  const [form, setForm] = useState(initial);
  const [key, setKey] = useState("");
  const [clear, setClear] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const loaded = useRef(false);
  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const value = {
          ...initial,
          ...(await api<Status>("/settings/embedding")),
        };
        if (!live) return;
        setStatus(value);
        if (!loaded.current) {
          loaded.current = true;
          setForm(value);
        }
      } catch (e) {
        if (live) setError(errorMessage(e));
      }
    }
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  function change(patch: Partial<Status>) {
    setForm({ ...form, ...patch });
    setDirty(true);
    setNotice("");
  }
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await api<Status>("/settings/embedding", "PUT", {
        enabled: form.enabled,
        url: form.url,
        model: form.model,
        api_key: clear ? "" : key || null,
      });
      setStatus(value);
      setForm(value);
      setKey("");
      setClear(false);
      setDirty(false);
      setNotice("已保存");
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await api<{ dimensions: number }>(
        "/settings/embedding/test",
        "POST",
      );
      setNotice(`连接成功 · ${value.dimensions} 维`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const configured = Boolean(status.key_configured && status.model);
  const localFixture = status.model?.startsWith("synthetic-");
  return (
    <ConnectionCard
      title="语义记忆检索"
      icon={SearchCheck}
      description={configured ? status.model || "" : "为长期记忆配置向量模型"}
      status={
        localFixture
          ? "模拟配置"
          : status.enabled && configured
            ? "已启用"
            : configured
              ? "已配置"
              : "待配置"
      }
      ready={Boolean(
        status.enabled && configured && !status.error && !localFixture,
      )}
      detail={
        status.error ||
        (status.enabled
          ? `已索引 ${status.indexed} / ${status.total}${status.indexing ? " · 更新中" : ""}`
          : "关键词检索可用")
      }
      onConfigure={() => {
        setForm(status);
        setDirty(false);
        setKey("");
        setClear(false);
        setError("");
        setOpen(true);
      }}
    >
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent className="connection-config-dialog embedding-dialog">
          <DialogHeader className="embedding-dialog-heading">
            <span className="embedding-dialog-icon" aria-hidden="true">
              <SearchCheck size={22} />
            </span>
            <span>
              <DialogTitle>语义记忆检索</DialogTitle>
              <DialogDescription>
                为长期记忆单独配置向量接口。聊天模型不受这里影响。
              </DialogDescription>
            </span>
          </DialogHeader>
          <label className="embedding-toggle-card">
            <span className="embedding-toggle-icon" aria-hidden="true">
              <Boxes size={18} />
            </span>
            <span className="embedding-toggle-copy">
              <strong>使用语义检索</strong>
              <small>
                按语义相似度召回相关记忆；关闭后仍可使用关键词检索。
              </small>
            </span>
            <Checkbox
              checked={form.enabled}
              disabled={busy}
              onCheckedChange={(checked) =>
                change({ enabled: checked === true })
              }
            />
          </label>
          <div className="embedding-form-card">
            <div className="embedding-section-title">
              <Link2 size={16} />
              <span>
                <strong>Embedding 接口</strong>
                <small>填写兼容 OpenAI Embeddings 的服务地址。</small>
              </span>
            </div>
            <div className="form-field">
              <Label htmlFor="embedding-url">Embedding 接口地址</Label>
              <Input
                id="embedding-url"
                value={form.url}
                disabled={busy}
                onChange={(e) => change({ url: e.target.value })}
                placeholder="https://example.com/v1"
              />
            </div>
            <div className="form-field">
              <Label htmlFor="embedding-model">Embedding 模型名称</Label>
              <Input
                id="embedding-model"
                value={form.model}
                disabled={busy}
                onChange={(e) => change({ model: e.target.value })}
                placeholder="例如：qwen3.7-text-embedding-flash"
              />
            </div>
            <div className="form-field">
              <div className="embedding-label-row">
                <Label htmlFor="embedding-key">
                  <KeyRound size={13} />
                  Embedding API 密钥
                </Label>
                {status.key_configured && (
                  <button
                    type="button"
                    className={`embedding-secret-action ${clear ? "is-clearing" : ""}`}
                    disabled={busy}
                    aria-label={
                      clear ? "撤销清除已保存的密钥" : "清除已保存的密钥"
                    }
                    onClick={() => {
                      setClear(!clear);
                      setKey("");
                      setDirty(true);
                    }}
                  >
                    {clear ? <Undo2 size={12} /> : null}
                    {clear ? "撤销清除" : "清除密钥"}
                  </button>
                )}
              </div>
              <Input
                id="embedding-key"
                type="password"
                autoComplete="new-password"
                value={key}
                disabled={busy}
                onChange={(e) => {
                  setKey(e.target.value);
                  setClear(false);
                  setDirty(true);
                }}
                placeholder={
                  clear
                    ? "保存后将移除已存密钥"
                    : status.key_configured
                      ? "密钥已保存，留空保持不变"
                      : "输入 API 密钥"
                }
              />
            </div>
          </div>
          {error && <ErrorNotice message={error} />}
          {(status.error || status.indexing) && (
            <p
              role="status"
              className={`embedding-index-error ${status.indexing ? "is-working" : ""}`}
            >
              {status.error ||
                `正在更新记忆索引：${status.indexed} / ${status.total}`}
            </p>
          )}
          <DialogFooter className="embedding-dialog-footer">
            <span className="embedding-footer-status" role="status">
              {notice ||
                (status.enabled
                  ? `已索引 ${status.indexed} / ${status.total}${status.indexing ? " · 更新中" : ""}`
                  : "当前使用关键词检索")}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy || dirty || !status.key_configured || !status.model
              }
              onClick={() => void test()}
            >
              {notice ? <CheckCircle2 size={14} /> : null}
              测试连接
            </Button>
            <Button
              size="sm"
              disabled={busy || !dirty}
              onClick={() => void save()}
            >
              {busy && <Loader2 size={14} className="spin" />}
              保存设置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConnectionCard>
  );
}
