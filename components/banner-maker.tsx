"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import { usePixels, type NeonTemplate } from "@/lib/pixel-store";

const FONTS = ["Tahoma", "Courier New", "Impact", "Arial Black", "Comic Sans MS", "Georgia", "Verdana"];
const TEXT_COLORS = ["#ffff00", "#ffffff", "#000000", "#ff0000", "#00ff00", "#0000ff", "#ff00ff", "#00ffff"];
const BG_COLORS = ["#008080", "#c0c0c0", "#000080", "#000000", "#ffffff", "#800000", "#008000", "#800080"];
const NEON: { value: NeonTemplate; label: string; color: string }[] = [
  { value: "none", label: "None", color: "transparent" },
  { value: "cyberpunk-pulse", label: "Cyberpunk", color: "#00ffff" },
  { value: "matrix", label: "Matrix", color: "#00ff41" },
  { value: "flashing", label: "Flashing", color: "#ff00ff" },
  { value: "glitch", label: "Glitch", color: "#ff0000" },
  { value: "rainbow", label: "Rainbow", color: "#ffffff" },
  { value: "sequential", label: "Sequential", color: "#ffffff" },
];

const SCALE = 8;

interface OwnedArea {
  groupId: string;
  cols: number;
  rows: number;
}

/**
 * Banner.exe — banner creation studio. Pick a size (in 10×10 px blocks), add
 * text/font/colors/neon/image/link, preview it live on a canvas, download it
 * as a PNG, and place it onto one of your purchased areas.
 */
export function BannerMaker() {
  const { publicKey } = useWallet();
  const { pixels, editArea } = usePixels();
  const owner = publicKey?.toBase58() ?? "";

  const [cols, setCols] = useState(3);
  const [rows, setRows] = useState(2);
  const [text, setText] = useState("YOUR AD");
  const [font, setFont] = useState("Impact");
  const [textColor, setTextColor] = useState("#ffff00");
  const [bgColor, setBgColor] = useState("#008080");
  const [imageUrl, setImageUrl] = useState("");
  const [neon, setNeon] = useState<NeonTemplate>("none");
  const [link, setLink] = useState("");
  const [target, setTarget] = useState("");
  const [status, setStatus] = useState("");
  const [frame, setFrame] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const ownedAreas = useMemo<OwnedArea[]>(() => {
    const map = new Map<string, OwnedArea>();
    for (const key in pixels) {
      const p = pixels[key];
      if (p.owner === owner && p.bannerGroupId) {
        if (!map.has(p.bannerGroupId)) {
          map.set(p.bannerGroupId, {
            groupId: p.bannerGroupId,
            cols: p.bannerCols ?? 1,
            rows: p.bannerRows ?? 1,
          });
        }
      }
    }
    return Array.from(map.values());
  }, [pixels, owner]);

  const neonColor = NEON.find((n) => n.value === neon)?.color ?? "transparent";

  useEffect(() => {
    if (neon !== "sequential") return;
    const id = setInterval(() => setFrame((f) => f + 1), 220);
    return () => clearInterval(id);
  }, [neon]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = cols * 10 * SCALE;
    const h = rows * 10 * SCALE;
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, w, h);

    const RAINBOW = ["#ff0000", "#ff7f00", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff"];
    const drawText = () => {
      ctx.font = `bold ${Math.max(8, Math.round(h * 0.4))}px "${font}"`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (neon === "rainbow") {
        const chars = (text || "").split("");
        const total = ctx.measureText(text || "").width;
        let cursor = w / 2 - total / 2;
        chars.forEach((ch, i) => {
          const cw = ctx.measureText(ch).width;
          const color = RAINBOW[i % RAINBOW.length];
          ctx.fillStyle = color;
          ctx.shadowColor = color;
          ctx.shadowBlur = 4;
          ctx.fillText(ch, cursor + cw / 2, h / 2);
          cursor += cw;
        });
        ctx.shadowBlur = 0;
      } else if (neon === "sequential") {
        const chars = (text || "").split("");
        const total = ctx.measureText(text || "").width;
        let cursor = w / 2 - total / 2;
        const lit = frame % Math.max(1, chars.length);
        chars.forEach((ch, i) => {
          const cw = ctx.measureText(ch).width;
          const on = i === lit;
          ctx.globalAlpha = on ? 1 : 0.25;
          ctx.fillStyle = textColor;
          ctx.shadowColor = textColor;
          ctx.shadowBlur = on ? 12 : 0;
          ctx.fillText(ch, cursor + cw / 2, h / 2);
          cursor += cw;
        });
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
      } else {
        if (neon !== "none") {
          ctx.shadowColor = neonColor;
          ctx.shadowBlur = 8;
        }
        ctx.fillStyle = textColor;
        ctx.fillText(text || "", w / 2, h / 2);
        ctx.shadowBlur = 0;
      }
    };

    if (imageUrl) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        ctx.drawImage(img, 0, 0, w, h);
        drawText();
      };
      img.onerror = drawText;
      img.src = imageUrl;
    } else {
      drawText();
    }
  }, [cols, rows, text, font, textColor, bgColor, imageUrl, neon, neonColor, frame]);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const w = cols * 10 * SCALE;
        const h = rows * 10 * SCALE;
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const cx = c.getContext("2d");
        if (!cx) return;
        const scale = Math.max(w / img.width, h / img.height);
        const sw = w / scale;
        const sh = h / scale;
        cx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, w, h);
        setImageUrl(c.toDataURL("image/png"));
        setStatus("Image uploaded & optimized to " + w + "x" + h + "px.");
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  }
  function download() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) {
        setStatus("Download failed.");
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `banner-${cols}x${rows}.png`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus("Banner downloaded.");
    });
  }

  function place() {
    const canvas = canvasRef.current;
    if (!target) {
      setStatus("Pick a purchased area first.");
      return;
    }
    if (!canvas) return;
    try {
      const dataUrl = canvas.toDataURL("image/png");
      editArea(target, { imageUrl: dataUrl, destination: link.trim(), message: text.trim() });
      setStatus("Banner placed on your area.");
    } catch {
      setStatus("Could not export (external image needs CORS).");
    }
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto bg-[#c0c0c0] p-3 text-xs">
      {/* Size */}
      <div className="flex items-center gap-2">
        <span>Size (blocks):</span>
        <input className="win98-field !w-16" type="number" min={1} max={20} value={cols} onChange={(e) => setCols(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
        <span>×</span>
        <input className="win98-field !w-16" type="number" min={1} max={20} value={rows} onChange={(e) => setRows(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
        <span className="text-[#808080]">({cols * 10}×{rows * 10} px)</span>
      </div>

      {/* Text + font */}
      <label className="text-xs" htmlFor="bm-text">Text</label>
      <input id="bm-text" className="win98-field" value={text} onChange={(e) => setText(e.target.value)} placeholder="YOUR AD" />
      <label className="text-xs" htmlFor="bm-font">Font</label>
      <select id="bm-font" className="win98-field" value={font} onChange={(e) => setFont(e.target.value)}>
        {FONTS.map((f) => (
          <option key={f} value={f}>{f}</option>
        ))}
      </select>

      {/* Colors */}
      <span className="text-xs">Text color</span>
      <div className="flex flex-wrap gap-1">
        {TEXT_COLORS.map((c) => (
          <button key={c} type="button" className="bevel-out-1 h-5 w-5" style={{ background: c, outline: textColor === c ? "2px solid #000" : "none" }} onClick={() => setTextColor(c)} />
        ))}
      </div>
      <span className="text-xs">Background</span>
      <div className="flex flex-wrap gap-1">
        {BG_COLORS.map((c) => (
          <button key={c} type="button" className="bevel-out-1 h-5 w-5" style={{ background: c, outline: bgColor === c ? "2px solid #000" : "none" }} onClick={() => setBgColor(c)} />
        ))}
      </div>

      {/* Neon */}
      <span className="text-xs">Neon effect</span>
      <div className="flex flex-wrap gap-1">
        {NEON.map((n) => (
          <button key={n.value} type="button" className="win98-button flex-1 !px-1 !py-1 text-[11px]" style={neon === n.value ? { background: "#000080", color: "#fff" } : undefined} onClick={() => setNeon(n.value)}>
            {n.label}
          </button>
        ))}
      </div>

      {/* Image + link */}
      <label className="text-xs" htmlFor="bm-img">Image (upload or URL)</label>
      <div className="flex gap-1">
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
        <button type="button" className="win98-button" onClick={() => fileRef.current?.click()}>Browse…</button>
        <input id="bm-img" className="win98-field" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="or paste https://.../logo.png" />
      </div>
      <label className="text-xs" htmlFor="bm-link">Link URL</label>
      <input id="bm-link" className="win98-field" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://your-site.com" />

      {/* Preview */}
      <span className="text-xs">Preview</span>
      <div className="bevel-in flex justify-center bg-[#404040] p-2">
        <canvas ref={canvasRef} style={{ width: "100%", maxWidth: 360, imageRendering: "auto" }} />
      </div>

      {/* Target area */}
      <label className="text-xs" htmlFor="bm-target">Place on purchased area</label>
      <select id="bm-target" className="win98-field" value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">— none —</option>
        {ownedAreas.map((a) => (
          <option key={a.groupId} value={a.groupId}>
            Area {a.cols}×{a.rows}
          </option>
        ))}
      </select>

      {/* Actions */}
      <div className="flex gap-2">
        <button type="button" className="win98-button flex-1" onClick={download}>Download PNG</button>
        <button type="button" className="win98-button flex-1" onClick={place}>Place on area</button>
      </div>
      {status && <div className="text-[11px] text-[#000080]">{status}</div>}
    </div>
  );
}
