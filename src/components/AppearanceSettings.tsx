import { useSyncExternalStore } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import {
  currentThemePreference,
  setTheme,
  subscribeTheme,
  type ThemePreference,
} from "@/lib/appearance";

const themes = [
  {
    id: "system",
    name: "跟随系统",
    description: "随系统外观，自动切换浅色与深色。",
    icon: Monitor,
  },
  {
    id: "cream",
    name: "奶油杏 · 浅色",
    description: "奶油底色，配上温暖的杏棕色。",
    icon: Sun,
  },
  {
    id: "warm-dark",
    name: "暖灰棕 · 深色",
    description: "暖灰底色，配上柔和的杏棕色。",
    icon: Moon,
  },
] as const;

export function AppearanceSettings() {
  const theme = useSyncExternalStore(
    subscribeTheme,
    currentThemePreference,
    () => "system" as ThemePreference,
  );
  return (
    <section className="appearance-settings" aria-label="外观设置">
      <div className="section-title">
        <h2>主题配色</h2>
        <p>选择浅色、深色，或跟随系统自动切换。</p>
      </div>
      <fieldset className="theme-options">
        <legend className="sr-only">主题颜色</legend>
        {themes.map(({ id, name, description, icon: Icon }) => (
          <label className="theme-option" key={id} data-selected={theme === id}>
            <input
              type="radio"
              name="theme-color"
              value={id}
              checked={theme === id}
              onChange={() => setTheme(id)}
              aria-label={name}
            />
            <div className="theme-preview" data-preview={id} aria-hidden="true">
              <span className="theme-preview-rail">
                <i />
                <i />
                <i />
              </span>
              <span className="theme-preview-content">
                <b>今天想做点什么？</b>
                <i />
                <span className="theme-preview-composer">
                  <i />
                  <i />
                </span>
              </span>
            </div>
            <span className="theme-option-copy">
              <strong>
                <Icon size={17} />
                {name}
              </strong>
              <small>{description}</small>
              <span className="theme-selection" aria-hidden="true">
                {theme === id && <Check size={15} />}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}
