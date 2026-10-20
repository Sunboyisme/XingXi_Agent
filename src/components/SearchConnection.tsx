import { useState } from "react";
import { Search, Loader2 } from "lucide-react";
import { api, type Settings } from "@/lib/api";
import { ConnectionCard } from "./ConnectionCard";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { ErrorNotice } from "./common";

export function SearchConnection({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: (value: Settings) => void;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [clear, setClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      onSaved(
        await api<Settings>("/settings", "PUT", {
          providers: [],
          search_key: clear ? "" : key || null,
          timezone: settings.timezone,
        }),
      );
      setKey("");
      setClear(false);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ConnectionCard
      title="联网查资料"
      description="Tavily 搜索与网页读取"
      icon={Search}
      status={settings.search_configured ? "已配置" : "待配置"}
      ready={settings.search_configured}
      detail={
        settings.search_configured ? "搜索工具可用" : "添加 Tavily API 密钥"
      }
      onConfigure={() => {
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
        <DialogContent className="connection-config-dialog">
          <DialogHeader>
            <DialogTitle>联网查资料</DialogTitle>
            <DialogDescription>
              配置 Tavily，供 XiaoXi 搜索资料和读取网页。
            </DialogDescription>
          </DialogHeader>
          <div className="form-field">
            <Label htmlFor="search-key">Tavily API 密钥</Label>
            <Input
              id="search-key"
              type="password"
              autoComplete="new-password"
              disabled={busy}
              value={key}
              placeholder={
                settings.search_configured ? "已保存；留空保持原密钥" : "tvly-…"
              }
              onChange={(e) => {
                setKey(e.target.value);
                setClear(false);
              }}
            />
            {settings.search_configured && (
              <button
                type="button"
                className="text-button danger"
                disabled={busy}
                onClick={() => {
                  setClear(!clear);
                  setKey("");
                }}
              >
                {clear ? "保存后清除密钥" : "清除已保存的密钥"}
              </button>
            )}
          </div>
          {error && <ErrorNotice message={error} />}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              {busy && <Loader2 size={14} className="spin" />}保存设置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConnectionCard>
  );
}
