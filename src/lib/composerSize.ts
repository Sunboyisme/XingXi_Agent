export function resizeMessageInput(input: HTMLTextAreaElement) {
  const scrollTop = input.scrollTop;
  input.style.height = "auto";
  const style = getComputedStyle(input);
  const minHeight = Number.parseFloat(style.minHeight) || 64;
  const maxHeight = Number.parseFloat(style.maxHeight) || 120;
  if (!input.scrollHeight) return;
  input.style.height = `${Math.min(Math.max(input.scrollHeight, minHeight), maxHeight)}px`;
  input.scrollTop = document.activeElement === input && input.selectionEnd === input.value.length
    ? input.scrollHeight : scrollTop;
}
