"use client";
// Adapted from the React Bits ThoughtLine supplied by the user; snapshots own work status.
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { animate, motion, useReducedMotion, useInView } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, SparklesIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import "./ThoughtLine.css";

interface Props {
  label?: string;
  doneLabel?: string;
  renderLabel?: (text: string, working: boolean) => ReactNode;
  glyph?: "sparkle" | "dot" | "none" | ReactNode;
  steps?: string[];
  collapsible?: boolean;
  collapseOnSettle?: boolean;
  color?: string;
  glyphColor?: string;
  fontSize?: number;
  breathPeriod?: number;
  breathDepth?: number;
  shimmer?: boolean;
  shimmerDuration?: number;
  settleDuration?: number;
  settleBlur?: number;
  working?: boolean;
  settleAfter?: number;
  elapsed?: number;
  showTimer?: boolean;
  onSettle?: (seconds: number) => void;
  className?: string;
  style?: CSSProperties;
  // Existing workflow disclosure and rich details remain owned by the chat message.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
  startedAt?: number;
}

const fmt = (seconds: number) =>
  seconds < 60
    ? `${seconds.toFixed(1)} 秒`
    : `${Math.floor(seconds / 60)} 分 ${(seconds % 60).toFixed(1)} 秒`;

export default function ThoughtLine({
  label = "正在思考…",
  doneLabel = "",
  renderLabel,
  glyph = "sparkle",
  steps = [],
  collapsible = true,
  collapseOnSettle = true,
  color = "var(--text-secondary)",
  glyphColor = "",
  fontSize = 16,
  breathPeriod = 1.6,
  breathDepth = 0.45,
  shimmer = true,
  shimmerDuration = 1.8,
  settleDuration = 350,
  settleBlur = 2,
  working = true,
  settleAfter = 0,
  elapsed,
  showTimer = true,
  onSettle,
  className = "",
  style,
  open: controlledOpen,
  onOpenChange,
  children,
  startedAt,
}: Props) {
  const reduce = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const visible = useInView(rootRef);
  const id = useId();
  const [view, setView] = useState({ working, choice: null as boolean | null, settled: false });
  if (view.working !== working) setView({ working, choice: null, settled: false });
  const isWorking = working && !view.settled;
  const open = controlledOpen ?? view.choice ?? (isWorking || !collapseOnSettle);
  const hasTrace = Boolean(children) || steps.length > 0;
  const toggle = collapsible && hasTrace;
  const doneText = doneLabel || (showTimer ? "思考用时" : "思考完成");
  const glyphRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<HTMLSpanElement>(null);
  const secondsRef = useRef(elapsed ?? 0);
  const previousWorking = useRef(isWorking);
  const callbackRef = useRef(onSettle);
  useEffect(() => {
    callbackRef.current = onSettle;
  }, [onSettle]);

  useEffect(() => {
    const paint = (seconds: number) => {
      secondsRef.current = Math.max(0, seconds);
      if (timerRef.current) timerRef.current.textContent = fmt(secondsRef.current);
    };
    if (elapsed != null) {
      paint(elapsed);
      return;
    }
    if (!isWorking) return;
    const start = startedAt ?? Date.now();
    const tick = () => {
      const seconds = (Date.now() - start) / 1000;
      paint(seconds);
      if (settleAfter > 0 && seconds >= settleAfter) setView((v) => ({ ...v, settled: true }));
    };
    tick();
    const timer = window.setInterval(tick, 100);
    return () => window.clearInterval(timer);
  }, [isWorking, elapsed, settleAfter, startedAt]);

  useEffect(() => {
    if (previousWorking.current && !isWorking) callbackRef.current?.(secondsRef.current);
    previousWorking.current = isWorking;
  }, [isWorking]);

  useEffect(() => {
    const element = glyphRef.current;
    if (!element) return;
    const animation =
      isWorking && visible && !reduce && breathDepth > 0
        ? animate(
            element,
            {
              opacity: [
                1 - Math.min(1, Math.max(0, breathDepth)),
                1,
                1 - Math.min(1, Math.max(0, breathDepth)),
              ],
            },
            { duration: breathPeriod, ease: [0.77, 0, 0.175, 1], repeat: Infinity },
          )
        : animate(
            element,
            { opacity: isWorking ? 1 : 0.55 },
            { duration: reduce ? 0 : settleDuration / 1000 },
          );
    return () => animation.stop();
  }, [isWorking, visible, reduce, breathDepth, breathPeriod, settleDuration, glyph]);

  const head = (
    <>
      {glyph !== "none" && (
        <span ref={glyphRef} className="thought-line__glyph" aria-hidden="true">
          {glyph === "sparkle" ? (
            <HugeiconsIcon icon={SparklesIcon} size="100%" strokeWidth={2} />
          ) : glyph === "dot" ? (
            <span className="thought-line__dot" />
          ) : (
            glyph
          )}
        </span>
      )}
      <span key={isWorking ? "working" : "settled"} className="thought-line__label">
        <span
          className="thought-line__breath"
          data-shimmer={isWorking && shimmer && !reduce ? "" : undefined}
        >
          {renderLabel
            ? renderLabel(isWorking ? label : doneText, isWorking)
            : isWorking
              ? label
              : doneText}
        </span>
      </span>
      {showTimer && (
        <motion.span
          layout="position"
          transition={{ duration: reduce ? 0 : settleDuration / 1000 }}
          ref={timerRef}
          className="thought-line__timer"
          aria-hidden="true"
        >
          {fmt(elapsed ?? 0)}
        </motion.span>
      )}
      {toggle && (
        <span className="thought-line__chevron" aria-hidden="true">
          <HugeiconsIcon icon={ArrowDown01Icon} size="1em" strokeWidth={2.2} />
        </span>
      )}
    </>
  );
  return (
    <div
      ref={rootRef}
      className={`thought-line ${className}`}
      data-animate={isWorking && visible ? "" : undefined}
      data-working={isWorking ? "" : undefined}
      data-open={open && hasTrace ? "" : undefined}
      style={
        {
          "--tl-font": `${fontSize}px`,
          "--tl-color": color,
          "--tl-glyph": glyphColor || color,
          "--tl-settle": `${settleDuration}ms`,
          "--tl-blur": `${settleBlur}px`,
          "--tl-shimmer": `${shimmerDuration}s`,
          "--tl-breath": `${breathPeriod}s`,
          "--tl-trough": 1 - Math.min(1, Math.max(0, breathDepth)),
          ...style,
        } as CSSProperties
      }
    >
      {toggle ? (
        <button
          type="button"
          className="thought-line__head"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            if (onOpenChange) onOpenChange(!open);
            else setView((v) => ({ ...v, choice: !open }));
          }}
        >
          {head}
          <span className="thought-line__sr">{open ? "收起详情" : "展开详情"}</span>
        </button>
      ) : (
        <div className="thought-line__head">{head}</div>
      )}
      <span className="thought-line__sr" role="status" aria-live="polite">
        {isWorking ? label : `${doneText}${showTimer && elapsed != null ? ` ${fmt(elapsed)}` : ""}`}
      </span>
      {hasTrace && (
        <div
          id={id}
          className="thought-line__trace"
          data-open={open ? "" : undefined}
          aria-hidden={!open}
          inert={!open}
        >
          <div className="thought-line__fold">
            <div className="thought-line__steps">
              {children ??
                steps.map((text, index) => {
                  const done = !isWorking || index < steps.length - 1;
                  return (
                    <div
                      key={`${index}-${text}`}
                      className="thought-line__step"
                      data-done={done ? "" : undefined}
                    >
                      <span className="thought-line__mark" aria-hidden="true">
                        {done ? (
                          <HugeiconsIcon icon={Tick02Icon} size="1em" strokeWidth={2.5} />
                        ) : (
                          <i className="thought-line__pulse" />
                        )}
                      </span>
                      <span>{text}</span>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
