import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ArrowDown } from "lucide-react";
import { Tooltip } from "radix-ui";

type Turn = { id: string; content: string; answer: string };
type View = { atLatest: boolean; activeTurn: string };

const TurnMarker = memo(function TurnMarker({
  turn,
  index,
  active,
  onNavigate,
}: {
  turn: Turn;
  index: number;
  active: boolean;
  onNavigate: (id: string) => void;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          aria-label={`第 ${index + 1} 轮：${turn.content.trim() || "图片消息"}`}
          aria-current={active ? "step" : undefined}
          onClick={() => onNavigate(turn.id)}
        />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="chat-turn-preview"
          side="left"
          sideOffset={12}
          collisionPadding={16}
        >
          <strong>{turn.content.trim() || "图片消息"}</strong>
          <p>{turn.answer.trim() || "尚无回答"}</p>
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
});

export const ChatScrollNavigation = memo(function ChatScrollNavigation({
  turns,
  scroller,
  thread,
  turnElements,
  followLatest,
}: {
  turns: Turn[];
  scroller: RefObject<HTMLDivElement | null>;
  thread: RefObject<HTMLDivElement | null>;
  turnElements: RefObject<Map<string, HTMLElement>>;
  followLatest: RefObject<boolean>;
}) {
  const [view, setView] = useState<View>({ atLatest: true, activeTurn: "" });
  const displayed = useRef(view);
  const updateView = useCallback((next: View) => {
    const previous = displayed.current;
    if (
      previous.atLatest === next.atLatest &&
      previous.activeTurn === next.activeTurn
    )
      return;
    displayed.current = next;
    setView(next);
  }, []);
  // Streaming changes the answer preview, but must not resubscribe scroll listeners.
  const turnIds = useMemo(
    () => turns.map((turn) => turn.id).join("|"),
    [turns],
  );

  useEffect(() => {
    const container = scroller.current;
    if (!container) return;
    const ids = turnIds ? turnIds.split("|") : [];
    let frame = 0;
    let previousTop = container.scrollTop;
    function inspect() {
      frame = 0;
      if (!container?.isConnected) return;
      const top = container.scrollTop;
      const distance = container.scrollHeight - top - container.clientHeight;
      if (top < previousTop && distance > 2) followLatest.current = false;
      if (distance <= 2) followLatest.current = true;
      previousTop = top;
      const boundary = container.getBoundingClientRect().top + 80;
      let activeTurn = ids[0] || "";
      let low = 0;
      let high = ids.length - 1;
      // Question positions follow DOM order; read only logarithmically many bounds.
      while (low <= high) {
        const middle = (low + high) >>> 1;
        const target = turnElements.current.get(ids[middle]);
        if (!target?.isConnected) break;
        if (target.getBoundingClientRect().top <= boundary) {
          activeTurn = ids[middle];
          low = middle + 1;
        } else high = middle - 1;
      }
      updateView({
        atLatest: followLatest.current || distance < 36,
        activeTurn,
      });
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(inspect);
    }
    function onWheel(event: WheelEvent) {
      if (event.deltaY < 0) followLatest.current = false;
    }
    function onTouchMove() {
      followLatest.current = false;
    }
    function onPointerDown(event: PointerEvent) {
      if (
        container &&
        event.clientX >= container.getBoundingClientRect().right - 16
      )
        followLatest.current = false;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (["ArrowUp", "PageUp", "Home"].includes(event.key))
        followLatest.current = false;
      if (event.key === "End") followLatest.current = true;
    }
    container.addEventListener("scroll", schedule, { passive: true });
    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: true });
    container.addEventListener("pointerdown", onPointerDown, { passive: true });
    container.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", schedule);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(container);
    if (thread.current) observer?.observe(thread.current);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      container.removeEventListener("scroll", schedule);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", schedule);
    };
  }, [scroller, thread, turnElements, followLatest, turnIds, updateView]);

  const navigate = useCallback(
    (id: string) => {
      const container = scroller.current;
      const target = turnElements.current.get(id);
      if (!container || !target) return;
      const top =
        container.scrollTop +
        target.getBoundingClientRect().top -
        container.getBoundingClientRect().top -
        24;
      followLatest.current = false;
      updateView({ atLatest: false, activeTurn: id });
      container.scrollTo({ top, behavior: "instant" });
    },
    [scroller, turnElements, followLatest, updateView],
  );

  return (
    <>
      {turns.length > 0 && (
        <Tooltip.Provider
          delayDuration={120}
          skipDelayDuration={100}
          disableHoverableContent
        >
          <nav className="chat-turn-nav" aria-label="对话定位">
            {turns.map((turn, index) => (
              <TurnMarker
                key={turn.id}
                turn={turn}
                index={index}
                active={view.activeTurn === turn.id}
                onNavigate={navigate}
              />
            ))}
          </nav>
        </Tooltip.Provider>
      )}
      {!view.atLatest && (
        <button
          type="button"
          className="chat-jump-latest"
          onClick={() => {
            followLatest.current = true;
            updateView({ ...displayed.current, atLatest: true });
            scroller.current?.scrollTo({
              top: scroller.current.scrollHeight,
              behavior: "smooth",
            });
          }}
        >
          <ArrowDown size={14} />
          回到最新
        </button>
      )}
    </>
  );
});
