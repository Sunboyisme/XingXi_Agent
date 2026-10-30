import { test, expect } from "@playwright/test";

// Configuration/layout regression with local responses; never calls a paid TTS service.
test("online TTS presets, voice selection and failed saves work in a short window", async ({
  page,
}) => {
  const defaults = [
    {
      provider: "bailian",
      label: "阿里云百炼",
      url: "https://example.com/ali",
      model: "qwen3-tts-flash",
      voice: "Cherry",
      voices: [{ value: "Cherry", label: "Cherry" }],
    },
    {
      provider: "siliconflow",
      label: "硅基流动",
      url: "https://example.com/v1/audio/speech",
      model: "FunAudioLLM/CosyVoice2-0.5B",
      voice: "FunAudioLLM/CosyVoice2-0.5B:alex",
      voices: [
        { value: "FunAudioLLM/CosyVoice2-0.5B:alex", label: "Alex" },
        {
          value: "FunAudioLLM/CosyVoice2-0.5B:claire",
          label: "Claire · 温柔女声",
        },
      ],
    },
    {
      provider: "minimax",
      label: "MiniMax",
      url: "https://example.com/v1/t2a_v2",
      model: "speech-2.8-turbo",
      voice: "male-qn-qingse",
      voices: [],
    },
    {
      provider: "custom",
      label: "自定义兼容接口",
      url: "",
      model: "",
      voice: "",
      voices: [],
    },
  ];
  let saved = {
    selected: "bailian",
    profiles: defaults.map(({ provider, url, model, voice }) => ({
      provider,
      url,
      model,
      voice,
      key_configured: false,
    })),
    presets: defaults.map((value) => ({
      ...value,
      models: [value.model],
      description: "在线合成，不下载语音模型。",
      docs_url: "",
    })),
  };
  let saves = 0;
  await page.route("**/api/v1/settings/tts", async (route) => {
    if (route.request().method() === "PUT") {
      saves++;
      if (saves === 1) {
        await route.fulfill({
          status: 500,
          json: { detail: "模拟暂时无法保存" },
        });
        return;
      }
      const value = route.request().postDataJSON();
      saved = {
        ...saved,
        selected: value.selected,
        profiles: value.profiles.map(
          ({ provider, url, model, voice, api_key }: any) => ({
            provider,
            url,
            model,
            voice,
            key_configured: Boolean(api_key),
          }),
        ),
      };
    }
    await route.fulfill({ json: saved });
  });
  await page.setViewportSize({ width: 700, height: 440 });
  await page.goto("/");
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "能力连接", exact: true }).click();
  await page.getByRole("button", { name: "配置语音朗读", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "语音朗读", exact: true });
  await expect(dialog.getByLabel("音色 ID", { exact: true })).toHaveValue(
    "Cherry",
  );
  await dialog.getByRole("combobox", { name: "朗读服务", exact: true }).click();
  await page.getByRole("option", { name: "硅基流动", exact: true }).click();
  await expect(dialog.getByLabel("语音模型", { exact: true })).toHaveValue(
    "FunAudioLLM/CosyVoice2-0.5B",
  );
  await dialog.getByRole("combobox", { name: "常用音色", exact: true }).click();
  await page
    .getByRole("option", { name: "Claire · 温柔女声", exact: true })
    .click();
  await expect(dialog.getByLabel("音色 ID", { exact: true })).toHaveValue(
    "FunAudioLLM/CosyVoice2-0.5B:claire",
  );
  await dialog
    .getByLabel("API 密钥", { exact: true })
    .fill("synthetic-tts-key");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    dialog.getByText("模拟暂时无法保存", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel("API 密钥", { exact: true })).toHaveValue(
    "synthetic-tts-key",
  );
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    dialog.getByText("在线朗读配置已保存", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel("API 密钥", { exact: true })).toHaveValue("");
  const box = await dialog.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(440);
  await expect(
    dialog.getByRole("button", { name: "保存", exact: true }),
  ).toBeInViewport();
  expect(
    await dialog
      .locator(".tts-form")
      .evaluate((node) => node.scrollHeight > node.clientHeight),
  ).toBe(true);
  await page.screenshot({
    path: ".local-data/full-review-20261030/online-tts-settings-narrow.png",
  });
});
