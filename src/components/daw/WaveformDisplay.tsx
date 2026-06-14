import React, { useRef, useEffect } from 'react';

interface WaveformDisplayProps {
  peaks: number[];
  peaksR?: number[] | null;
  color: string;
  height?: number;
  isPlaying?: boolean;
  isSelected?: boolean;
}

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ];
  }
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
};

// Draw a single channel waveform within a vertical slice [yTop, yBottom] of the canvas.
// Mirror: if true, waveform grows downward from yTop (right channel style).
function drawChannel(
  ctx: CanvasRenderingContext2D,
  peaks: number[],
  W: number,
  yTop: number,
  yBottom: number,
  r: number,
  g: number,
  b: number,
  flip = false,
) {
  const c = (a: number) => `rgba(${r},${g},${b},${a})`;
  const height = yBottom - yTop;
  const mid    = yTop + height / 2;
  const n      = peaks.length;

  const topPts: [number, number][] = peaks.map((p, i) => [
    (i / (n - 1)) * W,
    mid - Math.max(0, p) * (height / 2 - 1) * (flip ? -0.92 : 0.92),
  ]);
  const botPts: [number, number][] = peaks.map((p, i) => [
    (i / (n - 1)) * W,
    mid + Math.max(0, p) * (height / 2 - 1) * (flip ? -0.92 : 0.92),
  ]);

  ctx.beginPath();
  ctx.moveTo(topPts[0][0], topPts[0][1]);
  for (const [x, y] of topPts) ctx.lineTo(x, y);
  for (let i = botPts.length - 1; i >= 0; i--) ctx.lineTo(botPts[i][0], botPts[i][1]);
  ctx.closePath();

  // Dark muted fill — matches mixer channel strip tone
  ctx.fillStyle = c(0.28);
  ctx.fill();
  ctx.strokeStyle = c(0.65);
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: number[],
  peaksR: number[] | null | undefined,
  color: string,
) {
  const dpr  = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW === 0 || cssH === 0 || peaks.length === 0) return;

  const needW = Math.round(cssW * dpr);
  const needH = Math.round(cssH * dpr);
  if (canvas.width !== needW || canvas.height !== needH) {
    canvas.width  = needW;
    canvas.height = needH;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssW;
  const H = cssH;
  ctx.clearRect(0, 0, W, H);

  const [r, g, b] = hexToRgb(color);

  if (peaksR && peaksR.length > 0) {
    // Stereo: left channel in top half, right channel in bottom half
    // Thin divider line between them
    const half = H / 2;
    drawChannel(ctx, peaks,  W, 0,    half, r, g, b);
    drawChannel(ctx, peaksR, W, half, H,    r, g, b);
    // Separator line
    ctx.beginPath();
    ctx.moveTo(0, half);
    ctx.lineTo(W, half);
    ctx.strokeStyle = `rgba(0,0,0,0.5)`;
    ctx.lineWidth   = 1;
    ctx.stroke();
  } else {
    // Mono: single waveform filling the full height
    drawChannel(ctx, peaks, W, 0, H, r, g, b);
  }
}

const WaveformDisplay: React.FC<WaveformDisplayProps> = ({
  peaks,
  peaksR,
  color,
  height,
  isPlaying = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || peaks.length === 0) return;

    const render = () => drawWaveform(canvas, peaks, peaksR, color);

    const ro = new ResizeObserver(render);
    ro.observe(canvas);
    render();

    return () => ro.disconnect();
  }, [peaks, peaksR, color]);

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    width: '100%',
    height: height != null ? `${height}px` : '100%',
  };

  return (
    <div style={containerStyle}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
      {isPlaying && <div className="waveform-scan" />}
    </div>
  );
};

export default WaveformDisplay;
