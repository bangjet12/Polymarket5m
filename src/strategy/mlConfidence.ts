import { config } from '../config';
import {
  TradeSignal,
  MarketHistory,
  PolymarketMarket,
  MarketResolution,
  HistoricalTrade,
} from '../types';
import { HistoricalDataFeed } from '../feeds/historicalData';
import { TimeDecayEngine } from './timeDecay';
import { logger } from '../utils/logger';
import fs from 'fs';
import path from 'path';

/**
 * Machine Learning Confidence Layer
 * 
 * Trains and applies a lightweight ML model from historical Polymarket
 * resolution data to improve trade confidence scoring.
 * 
 * Features used:
 * - Divergence magnitude
 * - Time to expiry
 * - Market liquidity
 * - Volume patterns (24h volume, volume spike)
 * - Price momentum (5m candle trend)
 * - Cross-exchange price dispersion
 * - Moneyness (distance from spot to strike)
 * - Historical win rate for similar setups
 * 
 * Model: Logistic Regression (lightweight, no external ML libraries needed)
 * Training: Online learning from resolved market outcomes
 */

interface FeatureVector {
  divergence: number;
  timeToExpiry: number;        // hours
  liquidity: number;           // log-scaled
  volume24h: number;           // log-scaled
  volumeSpike: number;         // 0 or 1
  momentum: number;            // -1, 0, +1
  moneyness: number;           // normalized distance
  spread: number;              // bid-ask spread
  priceDispersion: number;     // cross-exchange disagreement
  vwapDistance: number;         // distance from VWAP
  tradeFrequency: number;      // trades per hour
  timeDecayScore: number;      // from TimeDecayEngine
}

interface TrainingExample {
  features: FeatureVector;
  label: number;               // 1 = profitable trade, 0 = unprofitable
  weight: number;              // recency weight
  timestamp: number;
}

interface ModelWeights {
  bias: number;
  weights: { [key in keyof FeatureVector]: number };
  trainingSamples: number;
  lastTrainedAt: number;
  accuracy: number;
  version: number;
}

export class MLConfidenceLayer {
  private model: ModelWeights;
  private trainingData: TrainingExample[] = [];
  private timeDecay: TimeDecayEngine;
  private historicalFeed: HistoricalDataFeed;
  private readonly modelPath: string;
  private readonly maxTrainingData = 1000;
  private readonly learningRate = 0.01;
  private readonly regularization = 0.001;

  constructor(historicalFeed: HistoricalDataFeed) {
    this.historicalFeed = historicalFeed;
    this.timeDecay = new TimeDecayEngine();
    this.modelPath = path.resolve(__dirname, '../../data/ml_model.json');

    // Initialize or load model
    this.model = this.loadModel() || this.initializeModel();
  }

  /**
   * Get ML-adjusted confidence score for a trade signal
   * Combines traditional confidence with ML prediction
   */
  getMLConfidence(
    signal: TradeSignal,
    history: MarketHistory | null,
    priceDispersion: number
  ): {
    mlConfidence: number;
    adjustedConfidence: number;
    features: FeatureVector;
    explanation: string;
  } {
    // Extract features
    const features = this.extractFeatures(signal, history, priceDispersion);

    // Get ML prediction (0-1)
    const mlPrediction = this.predict(features);

    // Blend ML prediction with traditional confidence
    // Weight: 60% traditional + 40% ML (ML gains weight as more training data)
    const mlWeight = Math.min(0.5, this.model.trainingSamples / 200);
    const tradWeight = 1 - mlWeight;
    const adjustedConfidence = tradWeight * signal.confidence + mlWeight * mlPrediction;

    const explanation = this.explainPrediction(features, mlPrediction);

    return {
      mlConfidence: mlPrediction,
      adjustedConfidence: Math.max(0, Math.min(1, adjustedConfidence)),
      features,
      explanation,
    };
  }

  /**
   * Extract feature vector from signal and market data
   */
  private extractFeatures(
    signal: TradeSignal,
    history: MarketHistory | null,
    priceDispersion: number
  ): FeatureVector {
    const market = signal.market;
    const timeRemaining = this.getTimeRemainingHours(market);

    // Volume spike detection
    let volumeSpike = 0;
    if (history) {
      volumeSpike = this.historicalFeed.hasVolumeSpike(market.id) ? 1 : 0;
    }

    // Momentum from historical candles
    const momentum = history ? this.historicalFeed.getPriceMomentum(market.id) : 0;

    // VWAP distance
    let vwapDistance = 0;
    if (history && history.vwap > 0) {
      vwapDistance = (signal.suggestedPrice - history.vwap) / history.vwap;
    }

    // Trade frequency (trades per hour in last 24h)
    let tradeFrequency = 0;
    if (history && history.tradeCount24h > 0) {
      tradeFrequency = history.tradeCount24h / 24;
    }

    // Moneyness
    const moneyness = signal.impliedPrice > 0
      ? (signal.spotPrice - signal.impliedPrice) / signal.impliedPrice
      : 0;

    // Time decay score
    const timeDecayResult = this.timeDecay.scoreTimeDecayOpportunity(
      market,
      signal.spotPrice,
      signal.impliedPrice,
      signal.suggestedPrice,
      2.0 // default daily volatility
    );

    // Spread (estimate from divergence if not available directly)
    const spread = signal.divergence > 0 ? signal.divergence / 100 * 0.3 : 0.02;

    return {
      divergence: signal.divergence,
      timeToExpiry: timeRemaining || 168,
      liquidity: Math.log1p(market.liquidity),
      volume24h: Math.log1p(history?.totalVolume24h || 0),
      volumeSpike,
      momentum,
      moneyness,
      spread,
      priceDispersion,
      vwapDistance,
      tradeFrequency,
      timeDecayScore: timeDecayResult.score / 100,
    };
  }

  /**
   * Logistic regression prediction
   */
  private predict(features: FeatureVector): number {
    let logit = this.model.bias;

    for (const key of Object.keys(features) as Array<keyof FeatureVector>) {
      logit += (features[key] || 0) * (this.model.weights[key] || 0);
    }

    // Sigmoid
    return 1 / (1 + Math.exp(-logit));
  }

  /**
   * Train model with a new outcome (online learning)
   * Call this when a trade resolves (win or loss)
   */
  train(
    signal: TradeSignal,
    history: MarketHistory | null,
    priceDispersion: number,
    wasProfit: boolean
  ): void {
    const features = this.extractFeatures(signal, history, priceDispersion);
    const label = wasProfit ? 1 : 0;

    // Add training example with recency weight
    const example: TrainingExample = {
      features,
      label,
      weight: 1.0,
      timestamp: Date.now(),
    };

    this.trainingData.push(example);
    if (this.trainingData.length > this.maxTrainingData) {
      this.trainingData.shift();
    }

    // Online gradient descent update
    this.updateWeights(features, label);

    // Periodically retrain on all data for better convergence
    if (this.trainingData.length % 20 === 0) {
      this.fullRetrain();
    }

    this.model.trainingSamples++;
    this.model.lastTrainedAt = Date.now();

    // Save model periodically
    if (this.model.trainingSamples % 10 === 0) {
      this.saveModel();
    }

    logger.info(`🧠 ML Model updated: ${this.model.trainingSamples} samples | ` +
                `Accuracy: ${(this.model.accuracy * 100).toFixed(1)}%`);
  }

  /**
   * Single-step gradient descent update (online learning)
   */
  private updateWeights(features: FeatureVector, label: number): void {
    const prediction = this.predict(features);
    const error = label - prediction;

    // Update bias
    this.model.bias += this.learningRate * error;

    // Update feature weights
    for (const key of Object.keys(features) as Array<keyof FeatureVector>) {
      const featureValue = features[key] || 0;
      const currentWeight = this.model.weights[key] || 0;

      // Gradient + L2 regularization
      const gradient = error * featureValue - this.regularization * currentWeight;
      this.model.weights[key] = currentWeight + this.learningRate * gradient;
    }
  }

  /**
   * Full batch retrain on all stored examples
   */
  private fullRetrain(): void {
    if (this.trainingData.length < 10) return;

    // Apply recency weighting (recent examples count more)
    const now = Date.now();
    for (const example of this.trainingData) {
      const ageHours = (now - example.timestamp) / (1000 * 60 * 60);
      example.weight = Math.exp(-ageHours / (24 * 30)); // half-life ~30 days
    }

    // Multiple passes over data
    const epochs = 5;
    for (let epoch = 0; epoch < epochs; epoch++) {
      for (const example of this.trainingData) {
        const prediction = this.predict(example.features);
        const error = (example.label - prediction) * example.weight;

        this.model.bias += this.learningRate * 0.5 * error;
        for (const key of Object.keys(example.features) as Array<keyof FeatureVector>) {
          const featureValue = example.features[key] || 0;
          const currentWeight = this.model.weights[key] || 0;
          const gradient = error * featureValue - this.regularization * currentWeight;
          this.model.weights[key] = currentWeight + this.learningRate * 0.5 * gradient;
        }
      }
    }

    // Calculate accuracy
    let correct = 0;
    for (const example of this.trainingData) {
      const pred = this.predict(example.features);
      const predLabel = pred >= 0.5 ? 1 : 0;
      if (predLabel === example.label) correct++;
    }
    this.model.accuracy = correct / this.trainingData.length;
    this.model.version++;

    logger.debug(`🧠 ML full retrain: accuracy=${(this.model.accuracy * 100).toFixed(1)}% | ` +
                 `v${this.model.version} | ${this.trainingData.length} examples`);
  }

  /**
   * Explain what factors contributed most to prediction
   */
  private explainPrediction(features: FeatureVector, prediction: number): string {
    const contributions: { key: string; value: number }[] = [];

    for (const key of Object.keys(features) as Array<keyof FeatureVector>) {
      const contribution = (features[key] || 0) * (this.model.weights[key] || 0);
      if (Math.abs(contribution) > 0.05) {
        contributions.push({ key, value: contribution });
      }
    }

    contributions.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    const top3 = contributions.slice(0, 3);

    const factors = top3.map(c => `${c.key}(${c.value > 0 ? '+' : ''}${c.value.toFixed(2)})`);
    return `ML=${(prediction * 100).toFixed(0)}% | Top factors: ${factors.join(', ')}`;
  }

  /**
   * Initialize fresh model with sensible default weights
   */
  private initializeModel(): ModelWeights {
    return {
      bias: 0,
      weights: {
        divergence: 0.15,        // higher divergence = more likely profitable
        timeToExpiry: -0.01,     // less time = more predictable (slightly positive)
        liquidity: 0.1,          // more liquidity = better execution
        volume24h: 0.05,         // more volume = more reliable market
        volumeSpike: 0.1,        // volume spikes often precede moves
        momentum: 0.08,          // trading with momentum is generally better
        moneyness: 0.12,         // deep ITM near expiry is very predictable
        spread: -0.2,            // wider spread = worse execution = less profit
        priceDispersion: -0.15,  // high dispersion = uncertain price = risky
        vwapDistance: -0.05,     // far from VWAP = potentially chasing
        tradeFrequency: 0.03,   // active market = better execution
        timeDecayScore: 0.2,     // high time decay score = favorable theta
      },
      trainingSamples: 0,
      lastTrainedAt: Date.now(),
      accuracy: 0.5,
      version: 1,
    };
  }

  /**
   * Save model to disk
   */
  private saveModel(): void {
    try {
      const dir = path.dirname(this.modelPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.modelPath, JSON.stringify(this.model, null, 2));
      logger.debug(`ML model saved (v${this.model.version})`);
    } catch (error: any) {
      logger.warn(`Failed to save ML model: ${error.message}`);
    }
  }

  /**
   * Load model from disk
   */
  private loadModel(): ModelWeights | null {
    try {
      if (fs.existsSync(this.modelPath)) {
        const data = fs.readFileSync(this.modelPath, 'utf-8');
        const model = JSON.parse(data) as ModelWeights;
        logger.info(`🧠 ML model loaded: v${model.version} | ` +
                    `${model.trainingSamples} samples | ` +
                    `accuracy=${(model.accuracy * 100).toFixed(1)}%`);
        return model;
      }
    } catch (error: any) {
      logger.warn(`Failed to load ML model: ${error.message}`);
    }
    return null;
  }

  /**
   * Get model statistics
   */
  getModelStats(): {
    version: number;
    trainingSamples: number;
    accuracy: number;
    topFeatures: { feature: string; weight: number }[];
  } {
    const topFeatures = Object.entries(this.model.weights)
      .map(([feature, weight]) => ({ feature, weight }))
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
      .slice(0, 5);

    return {
      version: this.model.version,
      trainingSamples: this.model.trainingSamples,
      accuracy: this.model.accuracy,
      topFeatures,
    };
  }

  private getTimeRemainingHours(market: PolymarketMarket): number | null {
    if (!market.endDate) return null;
    const expiry = new Date(market.endDate).getTime();
    const remaining = (expiry - Date.now()) / (1000 * 60 * 60);
    return remaining > 0 ? remaining : 0;
  }
}
