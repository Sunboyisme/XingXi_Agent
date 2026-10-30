import { createContext, useContext, useId } from "react";
import type { Settings } from "@/lib/api";
import { Label } from "./ui/label";
import { SoftSelect } from "./ui/soft-select";
import "../styles/quick-model-setup.css";

export const SharedCredentialsContext = createContext<Settings["providers"]>(
  [],
);

export function SharedCredentialSource({
  connectionId,
  url,
  disabled,
  onChange,
}: {
  connectionId?: string | null;
  url: string;
  disabled?: boolean;
  onChange: (id: string | null) => void;
}) {
  const id = useId();
  const connections = useContext(SharedCredentialsContext);
  const compatible = connections.filter((connection) => {
    if (!connection.key_configured) return false;
    try {
      return new URL(connection.model_url).origin === new URL(url).origin;
    } catch {
      return false;
    }
  });
  const selected = compatible.find(
    (connection) => connection.id === connectionId,
  );
  if (!compatible.length && !connectionId) return null;
  return (
    <div className="form-field shared-credential-source">
      <Label htmlFor={id}>密钥来源</Label>
      <SoftSelect
        id={id}
        label="密钥来源"
        value={connectionId || "independent"}
        disabled={disabled}
        options={[
          { value: "independent", label: "单独填写密钥" },
          ...compatible.map((connection) => ({
            value: connection.id,
            label: connection.label,
          })),
          ...(connectionId && !selected
            ? [{ value: connectionId, label: "原连接不可用，请重新选择" }]
            : []),
        ]}
        onValueChange={(value) =>
          onChange(value === "independent" ? null : value)
        }
      />
      {connectionId && (
        <small className={selected ? undefined : "field-error"}>
          {selected
            ? "共用这个模型连接的密钥，修改一次即可同步。"
            : "连接已变更或接口地址不匹配，请更换密钥来源。"}
        </small>
      )}
    </div>
  );
}
