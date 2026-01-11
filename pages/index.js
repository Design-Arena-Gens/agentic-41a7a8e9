import Head from "next/head";
import { useMemo, useState } from "react";
import { format } from "date-fns";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceArea
} from "recharts";

const DATA_LENGTH = 220;

function seededRandomGenerator(seed) {
  let value = seed;
  return function next() {
    const x = Math.sin(value) * 10000;
    value += 1;
    return x - Math.floor(x);
  };
}

function buildPriceSeries(length = DATA_LENGTH) {
  const rand = seededRandomGenerator(35);
  const baseDate = new Date();

  const series = [];
  let price = 102;

  for (let index = 0; index < length; index += 1) {
    const noise = (rand() - 0.5) * 1.8;
    const trend = Math.sin(index / 16) * 0.7 + Math.cos(index / 34) * 0.4;
    const momentum = index > 70 && index < 130 ? 1.05 : 0.45;
    price = Math.max(35, price + trend * 0.6 + noise + momentum * 0.2);

    series.push({
      date: new Date(baseDate.getTime() - (length - 1 - index) * 24 * 60 * 60 * 1000),
      close: Number(price.toFixed(2))
    });
  }

  return series;
}

function weightedMovingAverage(values, period, index) {
  if (period <= 1) {
    return values[index] ?? null;
  }

  if (index + 1 < period) {
    return null;
  }

  const denominator = (period * (period + 1)) / 2;
  let weightedSum = 0;

  for (let offset = 0; offset < period; offset += 1) {
    const weight = period - offset;
    const value = values[index - offset];
    if (value == null) {
      return null;
    }
    weightedSum += value * weight;
  }

  return weightedSum / denominator;
}

function computeHMA(values, period) {
  const normalizedPeriod = Math.max(2, Math.round(period));
  const halfPeriod = Math.max(2, Math.round(normalizedPeriod / 2));
  const sqrtPeriod = Math.max(2, Math.round(Math.sqrt(normalizedPeriod)));

  const wmaHalf = values.map((_, index) => weightedMovingAverage(values, halfPeriod, index));
  const wmaFull = values.map((_, index) => weightedMovingAverage(values, normalizedPeriod, index));

  const diffSeries = values.map((_, index) => {
    const halfValue = wmaHalf[index];
    const fullValue = wmaFull[index];
    if (halfValue == null || fullValue == null) {
      return null;
    }
    return 2 * halfValue - fullValue;
  });

  return diffSeries.map((_, index) => weightedMovingAverage(diffSeries, sqrtPeriod, index));
}

function standardDeviation(values) {
  if (values.length === 0) {
    return 0;
  }

  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  const variance =
    values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / (values.length || 1);

  return Math.sqrt(variance);
}

function computeAHMA(values, basePeriod, sensitivity) {
  const closingPrices = values.map((item) => item.close);
  const hma = computeHMA(closingPrices, basePeriod);
  const volPeriod = Math.max(5, Math.round(basePeriod / 2));

  const volatilitySeries = closingPrices.map((_, index) => {
    if (index + 1 < volPeriod) {
      return 0;
    }

    const window = closingPrices.slice(index - volPeriod + 1, index + 1);
    return standardDeviation(window);
  });

  const maxVolatility = volatilitySeries.reduce(
    (max, value) => (value > max ? value : max),
    0
  );

  let previousValue = null;

  return hma.map((value, index) => {
    if (value == null) {
      return null;
    }

    const volatility = volatilitySeries[index] || 0;
    const normalizedVol = maxVolatility === 0 ? 0 : volatility / maxVolatility;
    const adaptiveFactor = Math.min(0.85, sensitivity * normalizedVol);

    if (previousValue == null) {
      previousValue = value;
      return value;
    }

    const adjusted = value * (1 - adaptiveFactor) + previousValue * adaptiveFactor;
    previousValue = adjusted;
    return adjusted;
  });
}

function buildDataset(basePeriod, sensitivity) {
  const baseSeries = buildPriceSeries();
  const ahmaSeries = computeAHMA(baseSeries, basePeriod, sensitivity);

  return baseSeries.map((item, index) => ({
    date: format(item.date, "MMM dd"),
    close: item.close,
    ahma: ahmaSeries[index],
    bias: ahmaSeries[index] != null && item.close > ahmaSeries[index] ? "bullish" : "bearish"
  }));
}

function RecentBiasIndicator({ dataset }) {
  const lastPoint = dataset[dataset.length - 1];

  const trending =
    lastPoint.ahma != null && lastPoint.close > lastPoint.ahma ? "Bullish" : "Bearish";

  return (
    <div className="metric-card">
      <span className={`metric-dot ${trending === "Bullish" ? "bullish" : "bearish"}`} />
      <div>
        <p className="metric-label">Current Bias</p>
        <p className="metric-value">{trending}</p>
      </div>
    </div>
  );
}

function SlopeStrength({ dataset }) {
  const window = dataset.slice(-8).filter((item) => item.ahma != null);
  if (window.length < 2) {
    return null;
  }

  const first = window[0].ahma ?? 0;
  const last = window[window.length - 1].ahma ?? 0;
  const slope = ((last - first) / first) * 100;

  return (
    <div className="metric-card">
      <span className={`metric-dot ${slope >= 0 ? "bullish" : "bearish"}`} />
      <div>
        <p className="metric-label">Slope Strength</p>
        <p className="metric-value">{`${slope >= 0 ? "+" : ""}${slope.toFixed(2)}%`}</p>
      </div>
    </div>
  );
}

function PullbackDepth({ dataset }) {
  const window = dataset.slice(-20).filter((item) => item.ahma != null);
  if (window.length < 5) {
    return null;
  }

  const distances = window.map((item) => item.close - item.ahma);
  const mean = distances.reduce((acc, value) => acc + value, 0) / distances.length;
  const deviation = standardDeviation(distances);
  const latestDistance = distances[distances.length - 1];
  const zScore = deviation === 0 ? 0 : (latestDistance - mean) / deviation;

  return (
    <div className="metric-card">
      <span className={`metric-dot ${zScore >= 0 ? "bullish" : "neutral"}`} />
      <div>
        <p className="metric-label">Pullback Z-Score</p>
        <p className="metric-value">{zScore.toFixed(2)}</p>
      </div>
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  const price = payload.find((item) => item.dataKey === "close");
  const ahma = payload.find((item) => item.dataKey === "ahma");

  return (
    <div className="tooltip">
      <p className="tooltip-date">{label}</p>
      <div className="tooltip-row">
        <span>Price:</span>
        <span>{price?.value?.toFixed(2)}</span>
      </div>
      <div className="tooltip-row">
        <span>AHMA:</span>
        <span>{ahma?.value?.toFixed(2)}</span>
      </div>
      <div className="tooltip-row">
        <span>Bias:</span>
        <span>{price?.value > ahma?.value ? "Bullish" : "Bearish"}</span>
      </div>
    </div>
  );
};

function ControlPanel({ period, sensitivity, onPeriodChange, onSensitivityChange }) {
  return (
    <div className="control-panel">
      <div className="control-slot">
        <label htmlFor="period">Base Period: {period}</label>
        <input
          id="period"
          type="range"
          min={14}
          max={120}
          value={period}
          onChange={(event) => onPeriodChange(Number(event.target.value))}
        />
      </div>
      <div className="control-slot">
        <label htmlFor="sensitivity">
          Adaptive Sensitivity: {sensitivity.toFixed(2)}
        </label>
        <input
          id="sensitivity"
          type="range"
          min={0.1}
          max={0.85}
          step={0.05}
          value={sensitivity}
          onChange={(event) => onSensitivityChange(Number(event.target.value))}
        />
      </div>
    </div>
  );
}

export default function Home() {
  const [period, setPeriod] = useState(55);
  const [sensitivity, setSensitivity] = useState(0.35);

  const dataset = useMemo(() => buildDataset(period, sensitivity), [period, sensitivity]);

  const trendZones = useMemo(() => {
    const zones = [];
    let startIndex = null;
    let currentBias = null;

    dataset.forEach((item, index) => {
      if (item.ahma == null) {
        return;
      }

      if (currentBias == null) {
        currentBias = item.bias;
        startIndex = index;
        return;
      }

      if (item.bias !== currentBias) {
        zones.push({
          start: dataset[startIndex].date,
          end: dataset[index].date,
          bias: currentBias
        });
        currentBias = item.bias;
        startIndex = index;
      }
    });

    if (startIndex != null && currentBias != null) {
      zones.push({
        start: dataset[startIndex].date,
        end: dataset[dataset.length - 1].date,
        bias: currentBias
      });
    }

    return zones.filter((zone) => zone.start !== zone.end);
  }, [dataset]);

  return (
    <>
      <Head>
        <title>AHMA Indicator Studio</title>
        <meta name="description" content="Adaptive Hull Moving Average indicator playground." />
      </Head>

      <main className="page">
        <header className="hero">
          <div>
            <p className="badge">AHMA • Adaptive Hull Moving Average</p>
            <h1>Adaptive Hull MA Indicator</h1>
            <p className="subtitle">
              Visualize how the Adaptive Hull Moving Average reacts to market volatility. Tweak the
              base period and sensitivity to uncover trend rotations, pullback depth, and bias
              transitions in real time.
            </p>
          </div>
        </header>

        <ControlPanel
          period={period}
          sensitivity={sensitivity}
          onPeriodChange={setPeriod}
          onSensitivityChange={setSensitivity}
        />

        <section className="chart-card">
          <ResponsiveContainer width="100%" height={420}>
            <LineChart data={dataset} margin={{ top: 32, right: 28, bottom: 12, left: 0 }}>
              <defs>
                <linearGradient id="priceLine" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.2} />
                </linearGradient>
                <linearGradient id="ahmaLine" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f97316" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="#fb923c" stopOpacity={0.2} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" tick={{ fill: "#94a3b8", fontSize: 12 }} />
              <YAxis
                domain={["auto", "auto"]}
                tick={{ fill: "#94a3b8", fontSize: 12 }}
                tickFormatter={(value) => `$${value.toFixed(0)}`}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                verticalAlign="top"
                height={36}
                iconType="plainline"
                wrapperStyle={{ paddingBottom: 16 }}
              />
              {trendZones.map((zone) => (
                <ReferenceArea
                  key={`${zone.start}-${zone.end}`}
                  x1={zone.start}
                  x2={zone.end}
                  strokeOpacity={0}
                  fill={zone.bias === "bullish" ? "rgba(34,197,94,0.06)" : "rgba(239,68,68,0.06)"}
                />
              ))}
              <Line
                type="monotone"
                dataKey="close"
                stroke="url(#priceLine)"
                strokeWidth={2.6}
                dot={false}
                name="Price"
              />
              <Line
                type="monotone"
                dataKey="ahma"
                stroke="url(#ahmaLine)"
                strokeWidth={2.2}
                dot={false}
                name="AHMA"
              />
            </LineChart>
          </ResponsiveContainer>
        </section>

        <section className="metrics">
          <RecentBiasIndicator dataset={dataset} />
          <SlopeStrength dataset={dataset} />
          <PullbackDepth dataset={dataset} />
        </section>

        <section className="explain">
          <h2>Indicator Breakdown</h2>
          <div className="explain-grid">
            <div>
              <h3>Adaptive Engine</h3>
              <p>
                AHMA starts with the classic Hull Moving Average to tame lag while keeping the curve
                smooth. We then modulate the curve using a volatility-weighted blending factor,
                allowing the indicator to stay tight during breakout conditions and relax during
                choppy phases.
              </p>
            </div>
            <div>
              <h3>Bias Zones</h3>
              <p>
                Background shading reveals bullish and bearish regimes based on where price sits
                relative to the AHMA line. Short pullbacks to a rising AHMA often signal continuation
                setups, while deep excursions below a falling AHMA call for caution.
              </p>
            </div>
            <div>
              <h3>Pullback Toolkit</h3>
              <p>
                Z-Score statistics highlight when price has stretched beyond its recent relationship
                to the AHMA. Combine this with slope strength readings to spot high-probability trend
                rotations and breakout opportunities.
              </p>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
