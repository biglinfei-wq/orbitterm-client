import { useEffect, useMemo, useState } from 'react';

export interface MetricTrendPoint {
  at: number;
  value: number;
}

interface MetricTrendChartProps {
  title: string;
  valueText: string;
  points: MetricTrendPoint[];
  lineColor: string;
  fillColor: string;
  fixedMax?: number;
  windowSeconds?: number;
  tickSeconds?: number;
  chartHeight?: number;
  chartWidth?: number;
  className?: string;
  titleClassName?: string;
  valueClassName?: string;
  tickStroke?: string;
}

const DEFAULT_CHART_WIDTH = 320;
const DEFAULT_CHART_HEIGHT = 12;
const CHART_PADDING_X = 6;
const CHART_PADDING_Y = 2;

const clampNumber = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
};

export function MetricTrendChart({
  title,
  valueText,
  points,
  lineColor,
  fillColor,
  fixedMax,
  windowSeconds = 60,
  tickSeconds = 5,
  chartHeight = DEFAULT_CHART_HEIGHT,
  chartWidth = DEFAULT_CHART_WIDTH,
  className,
  titleClassName,
  valueClassName,
  tickStroke = 'rgba(129, 157, 195, 0.24)'
}: MetricTrendChartProps): JSX.Element {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const windowMs = windowSeconds * 1000;
  const minTs = now - windowMs;

  const visiblePoints = useMemo<MetricTrendPoint[]>(() => {
    const filtered = points
      .filter((item) => Number.isFinite(item.at) && item.at >= minTs)
      .sort((a, b) => a.at - b.at);

    if (filtered.length === 0) {
      return [
        { at: minTs, value: 0 },
        { at: now, value: 0 }
      ];
    }

    const first = filtered[0];
    if (first && first.at > minTs) {
      filtered.unshift({
        at: minTs,
        value: first.value
      });
    }

    const last = filtered[filtered.length - 1];
    if (last && last.at < now) {
      filtered.push({
        at: now,
        value: last.value
      });
    }

    return filtered;
  }, [minTs, now, points]);

  const maxValue = useMemo(() => {
    if (typeof fixedMax === 'number' && fixedMax > 0) {
      return fixedMax;
    }
    const peak = visiblePoints.reduce((result, item) => Math.max(result, item.value), 0);
    return Math.max(peak * 1.18, 1);
  }, [fixedMax, visiblePoints]);

  const safeWidth = Math.max(64, chartWidth);
  const safeHeight = Math.max(10, chartHeight);
  const chartInnerWidth = safeWidth - CHART_PADDING_X * 2;
  const chartInnerHeight = safeHeight - CHART_PADDING_Y * 2;

  const polylinePoints = useMemo(() => {
    return visiblePoints
      .map((item) => {
        const progress = clampNumber((item.at - minTs) / windowMs, 0, 1);
        const x = CHART_PADDING_X + progress * chartInnerWidth;
        const normalized = clampNumber(item.value / maxValue, 0, 1);
        const y = CHART_PADDING_Y + (1 - normalized) * chartInnerHeight;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }, [chartInnerHeight, chartInnerWidth, maxValue, minTs, visiblePoints, windowMs]);

  const areaPoints = useMemo(() => {
    if (!polylinePoints) {
      return '';
    }
    const baselineY = CHART_PADDING_Y + chartInnerHeight;
    return `${CHART_PADDING_X},${baselineY.toFixed(2)} ${polylinePoints} ${safeWidth - CHART_PADDING_X},${baselineY.toFixed(2)}`;
  }, [chartInnerHeight, polylinePoints, safeWidth]);

  const ticks = useMemo(() => {
    const list: Array<{ x: number; secondsAgo: number }> = [];
    for (let second = 0; second <= windowSeconds; second += tickSeconds) {
      const progress = 1 - second / windowSeconds;
      const x = CHART_PADDING_X + progress * chartInnerWidth;
      list.push({
        x,
        secondsAgo: second
      });
    }
    return list;
  }, [chartInnerWidth, tickSeconds, windowSeconds]);

  return (
    <article
      className={`min-w-[148px] rounded-md bg-[#091423] px-1.5 py-0.5 ring-1 ring-[#2a4365] ${
        className ?? ''
      }`}
    >
      <div className="mb-0.5 flex items-center justify-between">
        <p className={`font-medium text-[#abc2e4] ${titleClassName ?? 'text-[9px]'}`}>{title}</p>
        <p className={`font-semibold text-[#dbe9ff] ${valueClassName ?? 'text-[9px]'}`}>{valueText}</p>
      </div>

      <svg
        className="w-full"
        style={{ height: `${safeHeight}px` }}
        preserveAspectRatio="none"
        viewBox={`0 0 ${safeWidth} ${safeHeight}`}
      >
        {ticks.map((tick) => (
          <line
            key={`${tick.secondsAgo}-${tick.x}`}
            stroke={tickStroke}
            strokeDasharray="2 3"
            strokeWidth={1}
            x1={tick.x}
            x2={tick.x}
            y1={CHART_PADDING_Y}
            y2={safeHeight - CHART_PADDING_Y}
          />
        ))}

        {areaPoints ? (
          <polygon
            fill={fillColor}
            points={areaPoints}
          />
        ) : null}

        <polyline
          fill="none"
          points={polylinePoints}
          stroke={lineColor}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.4}
        />
      </svg>
    </article>
  );
}
