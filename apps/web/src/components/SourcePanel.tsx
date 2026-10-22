// Panel 1: the original, untouched and read-only. The selected claim's source span is boxed and
// scrolled into view. No download or print; a light watermark carries the operator and time.
import type { PdfPage, SourceView, TaskView } from "@vc/shared";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiBytes } from "../lib/api";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Span = { start: number; end: number } | null;

export function SourcePanel({ source, span, watermark, taskId, reference }: { source: SourceView; span: Span; watermark: string; taskId: string; reference: TaskView["reference"] }) {
  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1 overflow-hidden" onContextMenu={(e) => e.preventDefault()} data-testid="source-panel">
        {source.kind === "pdf" ? <PdfSource key={taskId} url={source.url} pages={source.pages} span={span} /> : <EmailSource text={source.text} quotedFrom={source.quotedFrom} span={span} />}
        <Watermark text={watermark} />
      </div>
      {reference && (
        <div className="shrink-0 border-t bg-slate-50 px-3 py-1.5 text-[12px]" data-testid="reference-card">
          <div className="font-medium text-slate-700">{reference.title}</div>
          <div className="flex flex-wrap gap-x-3 text-slate-600">
            {reference.rows.map(([k, v]) => (
              <span key={k}>
                <span className="text-slate-400">{k}</span> {v}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Watermark({ text }: { text: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 select-none overflow-hidden" aria-hidden>
      <div className="absolute -inset-1/2 flex rotate-[-24deg] flex-wrap content-start gap-x-24 gap-y-16 opacity-[0.07]">
        {Array.from({ length: 80 }, (_, i) => (
          <span key={i} className="whitespace-nowrap text-[13px] font-semibold text-slate-900">
            {text}
          </span>
        ))}
      </div>
    </div>
  );
}

type Rendered = { index: number; width: number; height: number; scale: number; viewport: pdfjs.PageViewport };

const ZOOMS = [1, 1.25, 1.5, 2];

function PdfSource({ url, pages, span }: { url: string; pages: PdfPage[]; span: Span }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1.5);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const [rendered, setRendered] = useState<Rendered[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiBytes(url);
        const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
        const width = ((scroller.current?.clientWidth ?? 600) - 24) * zoom;
        const out: Rendered[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const base = page.getViewport({ scale: 1 });
          const scale = width / base.width;
          const viewport = page.getViewport({ scale });
          out.push({ index: i - 1, width: viewport.width, height: viewport.height, scale, viewport });
        }
        if (cancelled) return;
        setRendered(out);
        requestAnimationFrame(async () => {
          for (const r of out) {
            const canvas = canvases.current[r.index];
            if (!canvas) continue;
            const ratio = window.devicePixelRatio || 1;
            canvas.width = r.width * ratio;
            canvas.height = r.height * ratio;
            const page = await doc.getPage(r.index + 1);
            await page.render({ canvasContext: canvas.getContext("2d")!, viewport: page.getViewport({ scale: r.scale * ratio }) }).promise;
          }
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, zoom]);

  const boxes = useMemo(() => {
    if (!span) return [];
    const out: { page: number; left: number; top: number; width: number; height: number }[] = [];
    for (const p of pages) {
      const r = rendered[p.index];
      if (!r || span.end <= p.start || span.start >= p.end) continue;
      for (const it of p.items) {
        if (it.e <= span.start || it.s >= span.end) continue;
        const len = Math.max(1, it.e - it.s);
        const x0 = it.x + (it.w * (Math.max(span.start, it.s) - it.s)) / len;
        const x1 = it.x + (it.w * (Math.min(span.end, it.e) - it.s)) / len;
        const [a, b, c, d] = r.viewport.convertToViewportRectangle([x0, it.y - it.h * 0.25, x1, it.y + it.h * 0.95]);
        out.push({ page: p.index, left: Math.min(a, c) - 2, top: Math.min(b, d) - 2, width: Math.abs(c - a) + 4, height: Math.abs(d - b) + 4 });
      }
    }
    return out;
  }, [span, pages, rendered]);

  useEffect(() => {
    const el = scroller.current?.querySelector("[data-hl='1']");
    el?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  }, [boxes]);

  if (error) return <div className="p-4 text-red-700">Couldn't show the PDF: {error}</div>;
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b bg-white px-2 py-1 text-[11px] text-slate-500">
        Zoom
        {ZOOMS.map((z) => (
          <button key={z} tabIndex={-1} className={`rounded px-1.5 ${z === zoom ? "bg-slate-800 text-white" : "hover:bg-slate-100"}`} onClick={() => setZoom(z)}>
            {Math.round(z * 100)}%
          </button>
        ))}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto bg-slate-200 p-3" data-testid="pdf-source">
        {rendered.length === 0 && <div className="p-4 text-slate-500">Loading the PDF…</div>}
        {rendered.map((r) => (
          <div key={r.index} className="relative mx-auto mb-3 bg-white shadow" style={{ width: r.width, height: r.height }}>
            <canvas ref={(el) => void (canvases.current[r.index] = el)} style={{ width: r.width, height: r.height }} />
            {boxes.map((b, i) =>
              b.page === r.index ? (
                // Scroll to the last box: on a label-and-value line the value comes last.
                <div key={i} data-hl={i === boxes.length - 1 ? "1" : undefined} data-testid="source-highlight" className="absolute rounded-sm border-2 border-accent bg-accent/15" style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />
              ) : null,
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The email as sanitised HTML in a sandboxed frame: the text is escaped (no markup from the
 * source is ever interpreted), scripts can't run and the CSP blocks remote images and requests.
 */
function EmailSource({ text, quotedFrom, span }: { text: string; quotedFrom: number | null; span: Span }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const srcdoc = useMemo(() => {
    const render = (from: number, to: number) => {
      if (!span || span.end <= from || span.start >= to) return escapeHtml(text.slice(from, to));
      const s = Math.max(from, span.start);
      const e = Math.min(to, span.end);
      return `${escapeHtml(text.slice(from, s))}<mark id="hl">${escapeHtml(text.slice(s, e))}</mark>${escapeHtml(text.slice(e, to))}`;
    };
    const cut = quotedFrom ?? text.length;
    const inQuoted = !!span && quotedFrom != null && span.end > quotedFrom;
    const quoted = quotedFrom != null ? `<details${inQuoted ? " open" : ""}><summary>Earlier messages</summary><pre>${render(cut, text.length)}</pre></details>` : "";
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
      body{font:13px/1.55 ui-sans-serif,system-ui,sans-serif;margin:12px;color:#0f172a;user-select:text}
      pre{white-space:pre-wrap;word-wrap:break-word;font:inherit;margin:0}
      mark{background:#dbeafe;outline:2px solid #2563eb;border-radius:2px;color:inherit}
      details{margin-top:12px;color:#475569}summary{cursor:pointer;font-size:12px}
      @media print{body{display:none}}
    </style></head><body><pre>${render(0, cut)}</pre>${quoted}</body></html>`;
  }, [text, quotedFrom, span]);

  useEffect(() => {
    const f = frame.current;
    if (!f) return;
    const scroll = () => f.contentDocument?.getElementById("hl")?.scrollIntoView({ block: "center" });
    f.addEventListener("load", scroll);
    scroll();
    return () => f.removeEventListener("load", scroll);
  }, [srcdoc]);

  // allow-same-origin without allow-scripts: nothing in the frame can run, and the parent can
  // scroll the highlight into view.
  return <iframe ref={frame} title="Source email" sandbox="allow-same-origin" srcDoc={srcdoc} className="h-full w-full bg-white" data-testid="email-source" />;
}
