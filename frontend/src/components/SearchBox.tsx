import { useEffect, useRef, useState } from "react";
import { searchStocks } from "../api";
import { useDebounce } from "../hooks/useDebounce";
import type { SearchCandidate } from "../types";

type Props = {
  onSelect: (candidate: SearchCandidate) => void;
  disabled?: boolean;
};

/**
 * 股票搜索框：输入防抖 300ms 后请求补全，支持方向键/回车键盘选择。
 */
export default function SearchBox({ onSelect, disabled }: Props) {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<SearchCandidate[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const debounced = useDebounce(query, 300);

  // 输入变化 → 请求补全（取消过期请求，避免竞态）
  useEffect(() => {
    const q = debounced.trim();
    if (!q) {
      setCandidates([]);
      setOpen(false);
      return;
    }

    const controller = new AbortController();
    searchStocks(q, controller.signal)
      .then((list) => {
        setCandidates(list);
        setOpen(list.length > 0);
        setActiveIndex(-1);
      })
      .catch(() => {
        /* 取消或失败：静默，保持上一状态 */
      });

    return () => controller.abort();
  }, [debounced]);

  // 点击外部关闭下拉
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function choose(c: SearchCandidate) {
    setQuery(`${c.name}（${c.code}）`);
    setOpen(false);
    onSelect(c);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || candidates.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % candidates.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + candidates.length) % candidates.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(candidates[activeIndex >= 0 ? activeIndex : 0]!);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={boxRef} className="relative">
      <label htmlFor="stock-input" className="block text-sm font-medium text-slate-700">
        股票代码 / 名称
      </label>
      <input
        id="stock-input"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls="stock-suggest"
        autoComplete="off"
        disabled={disabled}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => candidates.length > 0 && setOpen(true)}
        placeholder="如 600519 或 茅台"
        className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-slate-100"
      />

      {open && (
        <ul
          id="stock-suggest"
          role="listbox"
          className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg"
        >
          {candidates.map((c, i) => (
            <li
              key={c.secid}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActiveIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(c);
              }}
              className={`cursor-pointer px-3 py-2 text-sm ${
                i === activeIndex ? "bg-blue-50" : ""
              }`}
            >
              <span className="font-medium text-slate-800">{c.name}</span>
              <span className="ml-2 text-slate-500">{c.code}</span>
              <span className="ml-2 text-xs text-slate-400">{c.market}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
