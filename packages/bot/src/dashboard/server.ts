// Dashboard Server - Fase 3
// Puerto 3848, auth manu/br0m2026!, integración completa con Grid Engine

// 🚨 CRÍTICO: Forzar IPv4 ANTES de cualquier import que haga requests
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import express from 'express';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import { createServer } from 'node:http';
import { grvtClient } from '../api/client.js';
import { db } from '../database/db.js';
import { gridEngine } from '../bot/grid-engine.js';
import { getAuthStatus, authenticatedRequest } from '../api/auth.js';
import { mountV2 } from '../server/v2-bootstrap.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3848;

// Initialize database and grid engine
async function initializeServices() {
  try {
    console.log('🔧 Inicializando servicios...');

    // Initialize database
    await db.initialize();

    // Multi-tenant: bootstrap owner user (idempotent). Reads
    // OWNER_EMAIL + OWNER_INITIAL_PASSWORD from env. If users
    // table is empty, creates user 1 (admin) and backfills every
    // existing per-bot row to user_id=1. Skips silently after
    // the first run (any user already exists).
    const ownerEmail = process.env.OWNER_EMAIL;
    const ownerPassword = process.env.OWNER_INITIAL_PASSWORD;
    if (ownerEmail && ownerPassword) {
      try {
        const { hashPassword } = await import('../auth/passwords.js');
        const hash = await hashPassword(ownerPassword);
        const result = await db.ownerBootstrap({
          email: ownerEmail.toLowerCase().trim(),
          password_hash: hash,
        });
        if (result.created) {
          console.log(`👤 Owner user created: ${ownerEmail} (id=${result.userId})`);
          console.log(`⚠️  REMOVE OWNER_INITIAL_PASSWORD from .env after first boot`);
        } else {
          console.log(`👤 Owner bootstrap skipped (users already exist; owner=${result.userId})`);
        }

        // If GRVT env creds are present AND the owner doesn't have
        // DB-stored creds yet, encrypt and persist them so the owner
        // gets hasGrvtCreds=true and doesn't hit the onboarding page.
        const grvtApiKey = process.env.GRVT_API_KEY;
        const grvtApiSecret = process.env.GRVT_API_SECRET;
        const grvtTradingAddress = process.env.GRVT_TRADING_ADDRESS;
        const grvtAccountId = process.env.GRVT_ACCOUNT_ID || '';
        const grvtSubAccountId = process.env.GRVT_TRADING_ACCOUNT_ID || '';
        const hasDbCreds = await db.hasGrvtCredentials(result.userId);
        if (grvtApiKey && grvtApiSecret && grvtTradingAddress && grvtSubAccountId && !hasDbCreds) {
          try {
            const { encryptCredentialFields } = await import('../auth/crypto.js');
            const encrypted = encryptCredentialFields({
              apiKey: grvtApiKey,
              apiSecret: grvtApiSecret,
              tradingAddress: grvtTradingAddress,
              accountId: grvtAccountId,
              subAccountId: grvtSubAccountId,
            });
            await db.upsertGrvtCredentials({
              user_id: result.userId,
              ...encrypted,
              last_test_ok: true,
              last_test_error: null,
            });
            console.log(`🔐 Owner GRVT credentials encrypted and stored from env`);
          } catch (cryptoErr) {
            console.warn('⚠️  Failed to encrypt owner GRVT creds:', cryptoErr);
          }
        }
      } catch (err) {
        console.error('❌ Owner bootstrap failed:', err);
        // Non-fatal: server keeps starting. Admin can manually
        // create the owner via signup endpoint instead.
      }
    } else {
      console.log('ℹ️  OWNER_EMAIL/OWNER_INITIAL_PASSWORD not set — skipping owner bootstrap');
    }

    // ⚠️ FIX Bug 2: Auto-start grid engine monitoring
    await gridEngine.start();
    console.log('🤖 Grid Engine iniciado automáticamente');

    console.log('✅ Servicios inicializados');

  } catch (error) {
    console.error('❌ Error inicializando servicios:', error);
    process.exit(1);
  }
}

// Basic auth middleware
const basicAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Skip basic auth for the v2 surface — it has its own X-Api-Key / JWT
  // auth via the v2 router middleware. Without this skip, the global
  // basicAuth would 401 every v2 request before the router got a chance
  // to see it. The /ws upgrade path doesn't go through Express middleware
  // at all (the ws library handles it on its own), so no skip is needed
  // there.
  // Also skip for the v2 React SPA at /dashboard — the SPA itself is
  // public, the actual auth happens via JWT login inside the app
  // (POST /api/v2/auth/login). Basic auth here is just a duplicate
  // gate that confuses users.
  if (req.path === '/' || req.path.startsWith('/api/v2/') || req.path.startsWith('/dashboard')) {
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="GRVT Grid Bot Dashboard"');
    return res.status(401).send('Authentication required');
  }

  const credentials = Buffer.from(authHeader.slice(6), 'base64').toString();
  const [username, password] = credentials.split(':');

  if (username !== process.env.DASHBOARD_USER || password !== process.env.DASHBOARD_PASS) {
    return res.status(401).send('Invalid credentials');
  }

  next();
};

// Middleware
//
// SECURITY (H-7): helmet sets a curated set of response headers that
// block common browser-level attack vectors:
//   - X-Content-Type-Options: nosniff      (no MIME sniffing)
//   - X-Frame-Options: SAMEORIGIN          (no clickjacking via iframe)
//   - Strict-Transport-Security             (HTTPS-only for 1y, when behind TLS)
//   - Referrer-Policy: no-referrer          (no token leak via referer header)
//   - Cross-Origin-* policies               (isolate the dashboard process)
//
// Content-Security-Policy is disabled by default because the legacy
// dashboard at /dashboard/ relies on inline scripts; the v2 dashboard
// is served as a built Vite bundle and is CSP-friendly, but tightening
// CSP here would break the legacy UI. Set ENABLE_CSP=1 once the legacy
// dashboard is retired.
app.use(
  helmet({
    contentSecurityPolicy: process.env.ENABLE_CSP === '1' ? undefined : false,
    // crossOriginEmbedderPolicy can break embedded third-party charts;
    // leave it off (the only iframe risk is clickjacking, covered by frameguard).
    crossOriginEmbedderPolicy: false,
    // HSTS only makes sense behind TLS — the reverse proxy strips/sets it
    // anyway, but enabling it here means localhost dev curls don't get
    // upgraded by accident. Default is fine (1y, no preload).
  })
);
app.use(express.json());

// Debug logging middleware
app.use((req, res, next) => {
  console.log(`🔧 [DEBUG] ${req.method} ${req.path}`);
  next();
});

// Health endpoint BEFORE auth (for external monitoring)
app.get('/api/health', async (req, res) => {
  try {
    const uptimeMs = Math.round(process.uptime() * 1000);
    const uptimeSeconds = Math.round(process.uptime());
    const hours = Math.floor(uptimeSeconds / 3600);
    const mins = Math.floor((uptimeSeconds % 3600) / 60);
    const secs = uptimeSeconds % 60;
    const uptimeHuman = `${hours}h ${mins}m ${secs}s`;
    
    const mem = process.memoryUsage();
    
    res.json({
      status: 'ok',
      uptime: uptimeSeconds,
      uptimeHuman,
      activeOrders: (gridEngine as any).activeOrders?.size || 0,
      lastError: null,
      memory: {
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        rss: Math.round(mem.rss / 1024 / 1024)
      },
      timestamp: new Date().toISOString(),
      pid: process.pid
    });
  } catch (error) {
    res.json({ status: 'error', error: String(error), pid: process.pid });
  }
});

app.use(basicAuth);

// === API ENDPOINTS ===

// ⚠️ NOTA: Archivos estáticos se configuran DESPUÉS de los endpoints API

// System status
app.get('/api/status', async (req, res) => {
  try {
    console.log('🔧 [DEBUG] Status endpoint called');
    const authStatus = getAuthStatus();
    const dbStats = await db.getStats();
    
    res.json({
      connected: true,
      auth: authStatus,
      database: {
        connected: true,
        stats: dbStats
      },
      gridEngine: {
        running: gridEngine.listenerCount('botCreated') > 0, // Simple check
        timestamp: new Date().toISOString()
      },
      environment: process.env.NODE_ENV || 'development'
    });
    
  } catch (error) {
    console.error('API status error:', error);
    res.status(500).json({ 
      connected: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

// Get balance from GRVT
app.get('/api/balance', async (req, res) => {
  try {
    const balance = await grvtClient.getBalance();
    
    res.json({
      totalEquity: parseFloat(balance.total_equity).toFixed(2),
      availableBalance: parseFloat(balance.available_balance).toFixed(2),
      marginUsed: parseFloat(balance.margin_used).toFixed(2),
      maintenanceMargin: parseFloat(balance.maintenance_margin || '0').toFixed(2),
      currency: 'USDT',
      real: true,
      lastUpdate: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Balance error:', error);
    
    // Return mock data if auth fails
    res.json({
      totalEquity: '100.81',
      availableBalance: '85.45',
      marginUsed: '15.36',
      maintenanceMargin: '7.68',
      currency: 'USDT',
      real: false,
      error: 'Auth required - using demo data',
      lastUpdate: new Date().toISOString()
    });
  }
});

// Get real-time prices
app.get('/api/prices', async (req, res) => {
  try {
    const tickers = await grvtClient.getTickers(['BTC_USDT_Perp', 'ETH_USDT_Perp']);
    
    const formatTicker = (ticker: any) => ({
      price: parseFloat(ticker.last_price).toFixed(ticker.instrument.includes('BTC') ? 1 : 2),
      change24h: calculateChange24h(ticker.open_price, ticker.last_price),
      high24h: parseFloat(ticker.high_price).toFixed(ticker.instrument.includes('BTC') ? 1 : 2),
      low24h: parseFloat(ticker.low_price).toFixed(ticker.instrument.includes('BTC') ? 1 : 2),
      volume24h: parseFloat(ticker.buy_volume_24h_q || 0).toFixed(0),
      fundingRate: (parseFloat(ticker.funding_rate || 0) * 100).toFixed(4) + '%',
      markPrice: parseFloat(ticker.mark_price || ticker.last_price).toFixed(ticker.instrument.includes('BTC') ? 1 : 2)
    });
    
    const btcTicker = tickers.find(t => t.instrument === 'BTC_USDT_Perp');
    const ethTicker = tickers.find(t => t.instrument === 'ETH_USDT_Perp');
    
    res.json({
      BTCUSDT: btcTicker ? formatTicker(btcTicker) : null,
      ETHUSDT: ethTicker ? formatTicker(ethTicker) : null,
      lastUpdate: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Prices error:', error);
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

// Helper para calcular cambio 24h
function calculateChange24h(open: string, current: string): string {
  const openPrice = parseFloat(open);
  const currentPrice = parseFloat(current);
  const change = ((currentPrice - openPrice) / openPrice) * 100;
  return `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
}

// === BENCHMARK API ===
app.get('/api/benchmark', async (req, res) => {
  try {
    const INITIAL_INVESTMENT = 670;
    const INITIAL_ETH_PRICE = 2095; // Price when bot started (Mar 5)
    const initialEthAmount = INITIAL_INVESTMENT / INITIAL_ETH_PRICE;

    // Get current ETH price
    let currentEthPrice = 2300;
    try {
      const ticker = await grvtClient.getTicker('ETH_USDT_Perp');
      currentEthPrice = parseFloat(ticker.last_price || ticker.mark_price);
    } catch(e) { console.log('Benchmark: ticker error, using fallback'); }

    // Get current balance
    let balance = 0;
    let equity = 0;
    try {
      const summary = await authenticatedRequest(`${process.env.GRVT_TRADING_URL || 'https://trades.grvt.io/full/v1'}/account_summary`, {
        sub_account_id: process.env.GRVT_TRADING_ACCOUNT_ID || '3931648923440974'
      });
      balance = parseFloat(summary.spot_balances?.[0]?.balance || '0');
      const unrealized = parseFloat(summary.unrealized_pnl || '0');
      equity = balance + unrealized;
    } catch(e) { console.log('Benchmark: summary error'); }

    // Hold ETH: if you had just held ETH from day 1
    const holdValue = initialEthAmount * currentEthPrice;
    const holdRoi = ((holdValue - INITIAL_INVESTMENT) / INITIAL_INVESTMENT) * 100;

    // Bot Realized: actual balance vs investment
    const botRealizedRoi = ((balance - INITIAL_INVESTMENT) / INITIAL_INVESTMENT) * 100;

    // Bot Total: equity vs investment
    const botTotalRoi = ((equity - INITIAL_INVESTMENT) / INITIAL_INVESTMENT) * 100;

    // Alpha: bot total - hold
    const alpha = botTotalRoi - holdRoi;

    res.json({
      hold: { roi: holdRoi, value: holdValue, ethAmount: initialEthAmount },
      botRealized: { roi: botRealizedRoi, value: balance },
      botTotal: { roi: botTotalRoi, value: equity },
      alpha: alpha
    });
  } catch (error) {
    console.error('Benchmark error:', error);
    res.status(500).json({ error: 'Failed to calculate benchmark' });
  }
});

// === BOT MANAGEMENT APIs ===

// Get all bots
app.get('/api/bots', async (req, res) => {
  try {
    const bots = await gridEngine.getBotStatus();
    
    // ⚠️ FIX: Agregar métricas reales para cada bot
    const botsWithRealPnL = await Promise.all(
      bots.map(async (bot) => {
        const realPnL = await calculateRealPnL(bot.id);
        return {
          ...bot,
          pnl: realPnL.totalPnL,
          gridProfit: realPnL.gridProfit,
          gridProfitTotal: realPnL.gridProfitTotal,
          trendPnl: realPnL.trendPnL,
          feesPaid: realPnL.totalFees,
          fundingPaid: realPnL.totalFunding
        };
      })
    );
    
    res.json(botsWithRealPnL);
  } catch (error) {
    console.error('Error fetching bots:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Get specific bot
app.get('/api/bots/:id', async (req, res) => {
  try {
    const botId = parseInt(req.params.id);
    const bot = await db.getBot(botId);
    
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    // Parse params_json
    let params = {};
    try {
      params = JSON.parse(bot.params_json);
    } catch (e) {
      console.warn('Invalid params_json for bot', botId);
    }

    // ⚠️ FIX: Calcular PnL REAL descontando fees y funding
    const realPnLData = await calculateRealPnL(botId);

    res.json({
      id: bot.id,
      pair: bot.pair,
      direction: bot.direction,
      leverage: bot.leverage,
      lowerPrice: bot.lower_price,
      upperPrice: bot.upper_price,
      numGrids: bot.num_grids,
      investment: bot.investment_usdt,
      pnl: realPnLData.totalPnL,           // ⚠️ FIX: PnL real
      gridProfit: realPnLData.gridProfit,  // Grid profit desde último compound
      gridProfitTotal: realPnLData.gridProfitTotal,  // Grid profit total desde inicio
      trendPnl: realPnLData.trendPnL,      // ⚠️ FIX: Trend PnL neto
      feesPaid: realPnLData.totalFees,     // ⚠️ NUEVO: Fees pagados
      fundingPaid: realPnLData.totalFunding, // ⚠️ NUEVO: Funding pagado
      status: bot.status,
      positionSize: bot.position_size,
      avgEntryPrice: bot.avg_entry_price,
      liquidationPrice: bot.liquidation_price,
      createdAt: bot.created_at,
      ...params, // spacing, quantityPerGrid, estimatedProfitPerGrid
      compound_pct: (bot as any).compound_pct || 0,
      compound_threshold_usdt: (bot as any).compound_threshold_usdt || 50,
      compound_interval_hours: (bot as any).compound_interval_hours || 24,
      last_compound_at: (bot as any).last_compound_at || null,
      investment_usdt: bot.investment_usdt
    });
    
  } catch (error) {
    console.error('Error fetching bot:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Create new bot
app.post('/api/bots', async (req, res) => {
  try {
    const config = req.body;
    
    // Validate required fields
    const required = ['pair', 'direction', 'leverage', 'lowerPrice', 'upperPrice', 'numGrids', 'investmentUSDT'];
    for (const field of required) {
      if (!config[field]) {
        return res.status(400).json({ error: `Missing required field: ${field}` });
      }
    }

    console.log('📋 Creating bot with config:', JSON.stringify(config));
    const botId = await gridEngine.createBot(config);
    
    console.log(`✅ Bot creado via dashboard: ${botId}`);
    
    res.json({ 
      success: true, 
      botId,
      message: 'Bot creado exitosamente (PAUSADO)' 
    });
    
  } catch (error) {
    console.error('Error creating bot:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Start bot
app.post('/api/bots/:id/start', async (req, res) => {
  try {
    const botId = parseInt(req.params.id);
    await gridEngine.startBot(botId);
    
    console.log(`🚀 Bot iniciado via dashboard: ${botId}`);
    
    res.json({ 
      success: true, 
      message: 'Bot iniciado exitosamente' 
    });
    
  } catch (error) {
    console.error('Error starting bot:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Pause bot
app.post('/api/bots/:id/pause', async (req, res) => {
  try {
    const botId = parseInt(req.params.id);
    await gridEngine.pauseBot(botId);
    
    console.log(`⏸️ Bot pausado via dashboard: ${botId}`);
    
    res.json({ 
      success: true, 
      message: 'Bot pausado exitosamente' 
    });
    
  } catch (error) {
    console.error('Error pausing bot:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Close bot
app.post('/api/bots/:id/close', async (req, res) => {
  try {
    const botId = parseInt(req.params.id);
    await gridEngine.closeBot(botId);
    
    console.log(`🛑 Bot cerrado via dashboard: ${botId}`);
    
    res.json({ 
      success: true, 
      message: 'Bot cerrado exitosamente' 
    });
    
  } catch (error) {
    console.error('Error closing bot:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Delete bot (NUEVO según specs de Manu) - Como POST por problemas con Express routing
app.post('/api/bots/:id/delete', async (req, res) => {
  try {
    const botId = parseInt(req.params.id);
    
    // Verificar que el bot existe
    const bot = await db.getBot(botId);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    // SAFEGUARD: Solo permitir eliminación si el bot está detenido
    if (bot.status !== 'stopped') {
      return res.status(400).json({ 
        error: 'Solo se pueden eliminar bots en estado STOPPED. Pausá el bot antes de eliminarlo.' 
      });
    }
    
    console.log(`🗑️ [DEBUG] Eliminando bot ${botId} (status: ${bot.status})...`);
    
    // Eliminar bot de la database (CASCADE eliminará grid_levels, orders, trades, etc.)
    await db.deleteBot(botId);
    
    console.log(`🗑️ Bot eliminado via dashboard: ${botId} - ${bot.pair} ${bot.direction}`);
    
    res.json({ 
      success: true, 
      message: 'Bot eliminado exitosamente' 
    });
    
  } catch (error) {
    console.error('Error deleting bot:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Update bot leverage
app.post('/api/bots/:id/leverage', async (req, res) => {
  try {
    const botId = parseInt(req.params.id);
    const { leverage } = req.body;
    
    if (!leverage || leverage < 1 || leverage > 20) {
      return res.status(400).json({ error: 'Leverage debe estar entre 1 y 20' });
    }

    const bot = await db.getBot(botId);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    // Update leverage in GRVT
    await grvtClient.setLeverage(bot.pair, leverage);
    
    // Update in database
    await db.updateBot(botId, { leverage });
    
    console.log(`⚡ Leverage actualizado via dashboard: Bot ${botId} -> ${leverage}x`);
    
    res.json({ 
      success: true, 
      message: `Leverage actualizado a ${leverage}x` 
    });
    
  } catch (error) {
    console.error('Error updating leverage:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Update compound settings
app.post('/api/bots/:id/compound', async (req, res) => {
  try {
    const botId = parseInt(req.params.id);
    const { compound_pct, compound_threshold_usdt, compound_interval_hours } = req.body;
    
    const bot = await db.getBot(botId);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    await db.updateBot(botId, {
      compound_pct: parseFloat(compound_pct) || 0,
      compound_threshold_usdt: parseFloat(compound_threshold_usdt) || 50,
      compound_interval_hours: parseInt(compound_interval_hours) || 24
    } as any);
    
    console.log(`🔄 Compound settings updated for bot ${botId}: ${compound_pct}%, $${compound_threshold_usdt}, ${compound_interval_hours}h`);
    
    res.json({ 
      success: true, 
      message: 'Compound settings updated successfully' 
    });
    
  } catch (error) {
    console.error('Error updating compound settings:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Execute compound NOW (manual trigger)
app.post('/api/bots/:id/compound/execute', async (req, res) => {
  try {
    const botId = parseInt(req.params.id);
    const bot = await db.getBot(botId);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    const pct = (bot as any).compound_pct || 0;
    if (pct <= 0) {
      return res.json({ success: false, message: 'Compuesto desactivado (0%). Configurá un % primero.' });
    }
    
    // Get REAL grid profit from GRVT balance (source of truth)
    let gridProfit = (bot as any).grid_profit_usdt || 0;
    try {
      const { authenticatedRequest } = await import('../api/auth.js');
      const summary = await authenticatedRequest('https://trades.grvt.io/full/v1/account_summary', { sub_account_id: '3931648923440974' });
      const balance = parseFloat(summary.spot_balances?.[0]?.balance || '0');
      const investment = (bot as any).investment_usdt || 670;
      gridProfit = balance - investment; // Real profit = balance - what we put in
      console.log(`💰 Compound: GRVT balance $${balance.toFixed(2)} - investment $${investment.toFixed(2)} = profit $${gridProfit.toFixed(2)}`);
    } catch (e) {
      console.log(`⚠️ Compound: Could not fetch GRVT balance, using DB profit $${gridProfit.toFixed(2)}`);
    }
    
    const threshold = (bot as any).compound_threshold_usdt || 50;
    if (gridProfit < threshold) {
      return res.json({ 
        success: false, 
        message: `Profit ($${gridProfit.toFixed(2)}) menor al threshold ($${threshold}). Necesitás $${(threshold - gridProfit).toFixed(2)} más.` 
      });
    }
    
    const compoundAmount = gridProfit * (pct / 100);
    const newInvestment = ((bot as any).investment_usdt || 670) + compoundAmount;
    
    await db.updateBot(botId, { 
      investment_usdt: newInvestment,
      last_compound_at: new Date().toISOString()
    } as any);
    
    console.log(`⚡ MANUAL COMPOUND bot ${botId}: +$${compoundAmount.toFixed(2)} (${pct}% of $${gridProfit.toFixed(2)}) → investment now $${newInvestment.toFixed(2)}`);
    
    res.json({ 
      success: true, 
      message: `+$${compoundAmount.toFixed(2)} reinvertido. Inversión: $${newInvestment.toFixed(2)}` 
    });
    
  } catch (error) {
    console.error('Error executing compound:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Update bot range
app.post('/api/bots/:id/range', async (req, res) => {
  try {
    const botId = parseInt(req.params.id);
    const { lowerPrice, upperPrice } = req.body;
    
    if (!lowerPrice || !upperPrice || lowerPrice >= upperPrice) {
      return res.status(400).json({ error: 'Invalid price range' });
    }

    const bot = await db.getBot(botId);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    if (bot.status !== 'running') {
      return res.status(400).json({ error: 'Bot must be running to update range' });
    }

    // Calculate ETH check info before range update
    let ethCheckInfo = {
      ethNeeded: 0,
      ethAvailable: 0,
      deficit: 0,
      purchaseRequired: false
    };

    try {
      // Get current price for calculations
      const ticker = await grvtClient.getTicker(bot.pair);
      const currentPrice = parseFloat(ticker.last_price);

      // Calculate sell levels in new range
      const targetGrids = bot.num_grids;
      const newSpacing = (parseFloat(upperPrice) - parseFloat(lowerPrice)) / targetGrids;
      
      let sellLevelsCount = 0;
      for (let i = 0; i <= targetGrids; i++) {
        const price = parseFloat(lowerPrice) + (i * newSpacing);
        if (price > currentPrice) {
          sellLevelsCount++;
        }
      }

      // Calculate ETH needed (dynamic formula)
      const effectiveCapital = bot.investment_usdt * bot.leverage;
      const estimatedPrice = bot.pair.includes('ETH') ? currentPrice : 42000;
      const orderQty = effectiveCapital / (bot.num_grids * estimatedPrice);
      const ethNeeded = sellLevelsCount * orderQty;

      // Get current position
      let currentPosition = 0;
      try {
        const position = await grvtClient.getPosition(bot.pair);
        if (position) {
          currentPosition = parseFloat(position.size);
        }
      } catch (posErr) {
        console.log(`⚠️ Could not get position for ETH check: ${posErr}`);
      }

      const deficit = Math.max(0, ethNeeded - currentPosition);

      ethCheckInfo = {
        ethNeeded: Math.round(ethNeeded * 10000) / 10000,
        ethAvailable: Math.round(currentPosition * 10000) / 10000,
        deficit: Math.round(deficit * 10000) / 10000,
        purchaseRequired: deficit > 0.0001 // Only if deficit > 0.0001 ETH
      };

    } catch (ethCheckError) {
      console.log(`⚠️ Error calculating ETH check: ${ethCheckError}`);
    }

    await gridEngine.updateBotRange(botId, parseFloat(lowerPrice), parseFloat(upperPrice));
    
    console.log(`📊 Range updated for bot ${botId}: $${lowerPrice}-$${upperPrice}`);
    
    res.json({ 
      success: true, 
      message: 'Range updated successfully',
      ethCheck: ethCheckInfo
    });
    
  } catch (error) {
    console.error('Error updating bot range:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Get bot orders
app.get('/api/bots/:id/orders', async (req, res) => {
  try {
    const botId = parseInt(req.params.id);
    const orders = await db.getOrdersByBot(botId);
    res.json(orders);
  } catch (error) {
    console.error('Error fetching bot orders:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Get bot trades
app.get('/api/bots/:id/trades', async (req, res) => {
  try {
    const botId = parseInt(req.params.id);
    const trades = await db.getTradesByBot(botId);
    res.json(trades);
  } catch (error) {
    console.error('Error fetching bot trades:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Get bot funding history
app.get('/api/bots/:id/funding', async (req, res) => {
  try {
    const botId = parseInt(req.params.id);
    const funding = await db.getFundingHistoryByBot(botId);
    res.json(funding);
  } catch (error) {
    console.error('Error fetching bot funding:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Get equity curve data
app.get('/api/equity-curve', async (req, res) => {
  try {
    const botId = parseInt(req.query.botId as string) || 42;
    
    // First, let's add a method to the database class to query snapshots
    // For now, I'll create a temporary solution using raw SQL
    
    // Get the bot to know the initial investment
    const bot = await db.getBot(botId);
    if (!bot) {
      return res.status(404).json({ error: `Bot ${botId} not found` });
    }
    
    // Query snapshots directly using the internal db connection
    // This is a temporary solution until we add a proper method to the db class
    const database = (db as any).db; // Access the underlying sqlite3 database
    const snapshots = await new Promise<any[]>((resolve, reject) => {
      database.all(`
        SELECT * FROM daily_snapshots 
        WHERE bot_id = ? 
        ORDER BY timestamp ASC
      `, [botId], (err: any, rows: any[]) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    if (!snapshots || snapshots.length === 0) {
      return res.json([]);
    }
    
    console.log(`📊 Found ${snapshots.length} snapshots for bot ${botId}`);
    
    // Calculate additional metrics
    let maxBalance = bot.investment_usdt;
    const enrichedSnapshots = snapshots.map((snapshot, index) => {
      // Track maximum balance seen so far for drawdown calc
      maxBalance = Math.max(maxBalance, snapshot.balance_usdt);
      
      // Calculate daily return
      let daily_return_pct = 0;
      if (index > 0) {
        const prevBalance = snapshots[index - 1].balance_usdt;
        if (prevBalance > 0) {
          daily_return_pct = ((snapshot.balance_usdt - prevBalance) / prevBalance) * 100;
        }
      }
      
      // Calculate cumulative return
      const cumulative_return_pct = ((snapshot.balance_usdt - bot.investment_usdt) / bot.investment_usdt) * 100;
      
      // Calculate max drawdown from peak
      const max_drawdown_pct = maxBalance > 0 ? ((maxBalance - snapshot.balance_usdt) / maxBalance) * 100 : 0;
      
      // Calculate equity cumulative return
      const equity = snapshot.equity_usdt || snapshot.balance_usdt;
      const equity_return_pct = ((equity - bot.investment_usdt) / bot.investment_usdt) * 100;

      return {
        ...snapshot,
        equity_usdt: equity,
        daily_return_pct: parseFloat(daily_return_pct.toFixed(2)),
        cumulative_return_pct: parseFloat(cumulative_return_pct.toFixed(2)),
        equity_return_pct: parseFloat(equity_return_pct.toFixed(2)),
        max_drawdown_pct: parseFloat(max_drawdown_pct.toFixed(2))
      };
    });
    
    res.json(enrichedSnapshots);
    
  } catch (error) {
    console.error('Error fetching equity curve:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Test endpoint
app.get('/api/test', (req, res) => {
  console.log('🔧 [DEBUG] Test endpoint called');
  res.json({ message: 'Test endpoint works', timestamp: new Date().toISOString() });
});

// Health endpoint (sin auth - para monitoring externo)
app.get('/api/health', async (req, res) => {
  try {
    // Skip basic auth for health endpoint
    res.removeHeader('WWW-Authenticate');
    
    const startTime = process.uptime() * 1000; // Process uptime in ms
    let activeOrders = 0;
    let lastFillTimestamp: string | null = null;
    let lastError: string | null = null;
    let gridProfitNet: number | null = null;
    let memoryUsage = process.memoryUsage();
    
    try {
      // Get active orders count from GRVT
      const openOrders = await grvtClient.getOpenOrders();
      activeOrders = openOrders?.length || 0;
    } catch (e) {
      lastError = `Orders fetch error: ${e instanceof Error ? e.message : String(e)}`;
    }
    
    try {
      // Get last fill timestamp from database
      const recentTrades = await db.getRecentTrades(1);
      if (recentTrades && recentTrades.length > 0 && recentTrades[0]) {
        lastFillTimestamp = recentTrades[0].created_at;
      }
    } catch (e) {
      lastError = lastError ? lastError + '; ' : '' + `Trades fetch error: ${e instanceof Error ? e.message : String(e)}`;
    }
    
    try {
      // Get grid profit from grid engine
      if ((gridEngine as any).bot) {
        gridProfitNet = await (gridEngine as any).calculateRealGridProfit();
      }
    } catch (e) {
      lastError = lastError ? lastError + '; ' : '' + `Profit calc error: ${e instanceof Error ? e.message : String(e)}`;
    }
    
    const healthData = {
      status: 'ok',
      uptime: Math.floor(startTime),
      uptimeHuman: formatUptime(startTime),
      activeOrders,
      lastFillTimestamp,
      lastError,
      gridProfitNet: gridProfitNet ? parseFloat(gridProfitNet.toFixed(2)) : null,
      memory: {
        used: Math.round(memoryUsage.heapUsed / 1024 / 1024), // MB
        total: Math.round(memoryUsage.heapTotal / 1024 / 1024), // MB
        rss: Math.round(memoryUsage.rss / 1024 / 1024) // MB
      },
      timestamp: new Date().toISOString(),
      pid: process.pid
    };
    
    res.json(healthData);
    
  } catch (error) {
    console.error('❌ Health endpoint error:', error);
    res.status(500).json({ 
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    });
  }
});

// Helper function to format uptime
function formatUptime(uptimeMs: number): string {
  const seconds = Math.floor(uptimeMs / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

// NUEVO: Calcular máximo número de grids permitidos
app.get('/api/calculate-max-grids', async (req, res) => {
  try {
    const investment = parseFloat(req.query.investment as string) || 670;
    const leverage = parseInt(req.query.leverage as string) || 10;
    const lowerPrice = parseFloat(req.query.lowerPrice as string) || 1800;
    const upperPrice = parseFloat(req.query.upperPrice as string) || 2450;
    const pair = (req.query.pair as string) || 'ETH_USDT_Perp';
    
    const ticker = await grvtClient.getTicker(pair);
    const currentPrice = parseFloat(ticker.last_price);
    
    const minNotional = pair === 'ETH_USDT_Perp' ? 20 : 100;
    const minSize = pair === 'ETH_USDT_Perp' ? 0.01 : 0.001;
    const effectiveCapital = investment * leverage;
    
    // Min qty at lowest price (worst case margin)
    const minQtyForNotional = Math.ceil(minNotional / lowerPrice / minSize) * minSize;
    const costPerGrid = minQtyForNotional * currentPrice;
    const maxGridsRaw = Math.floor(effectiveCapital / costPerGrid);
    const maxGrids = Math.min(maxGridsRaw, 95); // GRVT limit 100, safety margin
    
    const spacing = maxGrids > 0 ? (upperPrice - lowerPrice) / maxGrids : 0;
    
    res.json({
      maxGrids,
      effectiveCapital: effectiveCapital.toFixed(2),
      costPerGrid: costPerGrid.toFixed(2),
      minQtyPerGrid: minQtyForNotional,
      spacing: spacing.toFixed(2),
      currentPrice,
      grvtLimit: 95,
      investment,
      leverage
    });
    
  } catch (error) {
    console.error('Error calculating max grids:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// === ENGINE CONTROL APIs ===

// Start grid engine
app.post('/api/engine/start', async (req, res) => {
  try {
    await gridEngine.start();
    
    console.log('🤖 Grid Engine iniciado via dashboard');
    
    res.json({ 
      success: true, 
      message: 'Grid Engine iniciado exitosamente' 
    });
    
  } catch (error) {
    console.error('Error starting grid engine:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Stop grid engine
app.post('/api/engine/stop', async (req, res) => {
  try {
    await gridEngine.stop();
    
    console.log('🛑 Grid Engine detenido via dashboard');
    
    res.json({ 
      success: true, 
      message: 'Grid Engine detenido exitosamente' 
    });
    
  } catch (error) {
    console.error('Error stopping grid engine:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// === STATIC FILES ===
// ⚠️ FIX: Servir archivos estáticos DESPUÉS de los endpoints API
const publicPath = process.env.NODE_ENV === 'development' ? 
  path.join(__dirname, 'public') : 
  path.join(__dirname, 'public'); // En ambos casos debería funcionar

app.use(express.static(publicPath));
console.log(`📁 Serving static files from: ${publicPath}`);

// === MAIN DASHBOARD PAGE ===
// Redirect bare host to the v2 SPA so users land directly on the JWT
// login instead of the legacy basic-auth gate.
app.get('/', (req, res) => {
  res.redirect('/dashboard/');
});

// Legacy dashboard kept reachable for compatibility but moved off the root.
app.get('/legacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === V2 DASHBOARD (React SPA, gated by basic auth like the legacy one) ===
// Looks for the prebuilt SPA at /opt/grvt-grid-bot/dashboard-dist (production)
// or ../../dashboard-dist relative to dist/ during local dev. If neither exists,
// this is a no-op so the bot still boots without the new dashboard.
const dashV2Candidates = [
  process.env.DASHBOARD_V2_DIST,
  '/opt/grvt-grid-bot/dashboard-dist',
  path.join(__dirname, '..', '..', 'dashboard-dist'),
].filter((p): p is string => !!p);
const dashV2Path = dashV2Candidates.find((p) => {
  try { return fs.existsSync(path.join(p, 'index.html')); } catch { return false; }
});
if (dashV2Path) {
  // Cache strategy:
  //   /assets/* → hashed filenames → cache forever (immutable)
  //   index.html (and any other unhashed file) → no-cache, must revalidate
  // This avoids the stale-chunk problem after a deploy: the browser always
  // re-fetches index.html, which references the new asset hashes.
  app.use('/dashboard', express.static(dashV2Path, {
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    },
  }));
  // SPA fallback: any deep link / refresh under /dashboard/* serves index.html
  // so the React Router can take over client-side. Excludes static assets
  // (already handled by express.static above) by checking that the path has
  // no file extension OR ends in /.
  app.get(/^\/dashboard(\/.*)?$/, (req, res, next) => {
    if (path.extname(req.path)) return next();  // let static handle .js/.css
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(dashV2Path, 'index.html'), (err) => {
      if (err) next(err);
    });
  });
  console.log(`📁 Serving v2 dashboard from: ${dashV2Path} (mounted at /dashboard)`);
} else {
  console.log(`⚠️  v2 dashboard not deployed (no dashboard-dist found)`);
}

// === V2 ROUTER PLACEHOLDER ===
// The v2 surface (REST + WebSocket) is mounted in startServer() AFTER
// initializeServices() so it has access to the live grvtClient + db + engine.
// Express dispatches middlewares in registration order, so we need v2 to be
// registered BEFORE the 404 handler below. We do that by calling mountV2()
// from startServer() and ensuring startServer() runs the wiring before the
// 404 handler is hit (which only happens at request time, not module load).
//
// Concretely: the 404 handler below IS registered at module load, but Express
// only walks the middleware stack in order at REQUEST time. So as long as
// mountV2() inserts /api/v2/* into the stack BEFORE a request arrives, it
// works. We use app._router.stack manipulation to insert at the right
// position, OR — much simpler — we register a deferred mount middleware
// here that the bootstrap function fills in.
//
// Approach: register a router placeholder NOW (so it's in stack order before
// the 404), and let mountV2() swap its handler in later via a closure.
// The placeholder forwards to a dynamically-set router or 404s with a clear
// message if v2 is disabled.
//
// This pattern is safer than reordering startServer because it preserves the
// module-load-time stack registration order that Express depends on.
let v2RouterRef: express.Router | null = null;
export function setV2Router(router: express.Router): void {
  v2RouterRef = router;
}
app.use('/api/v2', (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (v2RouterRef) {
    v2RouterRef(req, res, next);
  } else {
    res.status(503).json({ error: 'v2 surface not configured', hint: 'set DASHBOARD_API_KEY' });
  }
});

// === ERROR HANDLING ===
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Dashboard error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// === HELPER FUNCTIONS ===

/**
 * ⚠️ NUEVO: Calcular PnL real descontando fees y funding
 */
async function calculateRealPnL(botId: number): Promise<{
  gridProfit: number;
  gridProfitTotal: number;
  trendPnL: number; 
  totalPnL: number;
  totalFees: number;
  totalFunding: number;
}> {
  try {
    const bot = await db.getBot(botId);
    if (!bot) {
      throw new Error(`Bot ${botId} no encontrado`);
    }

    // 1. Calcular fees totales desde trades
    const trades = await db.getTradesByBot(botId);
    const totalFees = trades.reduce((sum, trade) => sum + trade.fee, 0);
    console.log(`💰 [DEBUG] Bot ${botId} fees totales: ${totalFees}`);

    // 2. Calcular funding totales 
    const fundingHistory = await db.getFundingHistoryByBot(botId);
    const totalFunding = fundingHistory.reduce((sum, funding) => sum + Math.abs(funding.payment_usdt), 0);
    console.log(`💰 [DEBUG] Bot ${botId} funding total: ${totalFunding}`);

    // 3. Get ALL PnL data directly from GRVT account_summary (source of truth)
    let gridProfitNet = 0;
    let gridProfitTotal = 0;
    let trendPnLGross = 0;
    let grvtEquity = 0;
    let grvtBalance = 0;
    try {
      const { authenticatedRequest } = await import('../api/auth.js');
      const summary = await authenticatedRequest('https://trades.grvt.io/full/v1/account_summary', {sub_account_id: '3931648923440974'});
      grvtEquity = parseFloat(summary.total_equity) || 0;
      grvtBalance = parseFloat(summary.spot_balances?.[0]?.balance) || 0;
      const unrealizedPnl = parseFloat(summary.unrealized_pnl) || 0;
      const position = summary.positions?.[0];
      const cumulativeFee = position ? parseFloat(position.cumulative_fee) || 0 : 0;
      const cumulativeFunding = position ? parseFloat(position.cumulative_realized_funding_payment) || 0 : 0;
      
      // Grid Profit = SUM of permanently paired round-trip spreads
      // Uses better-sqlite3 for sync access to fills_archive + paired_roundtrips
      const REINVERSION = bot.total_reinvested || 345.41;
      
      try {
        const { default: BetterSqlite } = await import('better-sqlite3');
        const sdb = new BetterSqlite('data/grid_bot.db');
        
        // Ensure tables exist
        sdb.exec(`CREATE TABLE IF NOT EXISTS fills_archive (
          id INTEGER PRIMARY KEY AUTOINCREMENT, fill_id TEXT UNIQUE,
          event_time TEXT, is_buyer BOOLEAN, price REAL, size REAL, fee REAL,
          created_at TEXT DEFAULT (datetime('now'))
        )`);
        sdb.exec(`CREATE TABLE IF NOT EXISTS paired_roundtrips (
          id INTEGER PRIMARY KEY AUTOINCREMENT, buy_fill_id TEXT, sell_fill_id TEXT,
          buy_price REAL, sell_price REAL, size REAL, profit REAL,
          created_at TEXT DEFAULT (datetime('now')), UNIQUE(buy_fill_id, sell_fill_id)
        )`);
        
        // Sync fills from API
        const fillsResp = await authenticatedRequest('https://trades.grvt.io/full/v1/fill_history', {
          sub_account_id: '3931648923440974', limit: 1000
        });
        const apiFills = fillsResp.results || fillsResp;
        const ins = sdb.prepare('INSERT OR IGNORE INTO fills_archive (fill_id, event_time, is_buyer, price, size, fee) VALUES (?, ?, ?, ?, ?, ?)');
        for (const f of apiFills) {
          ins.run(f.fill_id || f.trade_id || f.event_time, f.event_time, f.is_buyer ? 1 : 0, parseFloat(f.price), parseFloat(f.size), parseFloat(f.fee));
        }
        
        // Pair unpaired fills
        const pairedSet = new Set<string>();
        for (const r of sdb.prepare('SELECT buy_fill_id, sell_fill_id FROM paired_roundtrips').all() as any[]) {
          pairedSet.add(r.buy_fill_id);
          pairedSet.add(r.sell_fill_id);
        }
        const allFills = sdb.prepare('SELECT * FROM fills_archive ORDER BY event_time ASC').all() as any[];
        const uBuys = allFills.filter((f: any) => f.is_buyer && !pairedSet.has(f.fill_id) && f.size >= 0.01 && f.size <= 0.05);
        const uSells = allFills.filter((f: any) => !f.is_buyer && !pairedSet.has(f.fill_id) && f.size >= 0.01 && f.size <= 0.05);
        
        const used = new Set<number>();
        const insPair = sdb.prepare('INSERT OR IGNORE INTO paired_roundtrips (buy_fill_id, sell_fill_id, buy_price, sell_price, size, profit) VALUES (?, ?, ?, ?, ?, ?)');
        for (const buy of uBuys) {
          let bi = -1, bs = Infinity;
          for (let i = 0; i < uSells.length; i++) {
            if (used.has(i)) continue;
            const sp = uSells[i].price - buy.price;
            if (sp > 3 && sp < 15 && sp < bs) { bs = sp; bi = i; }
          }
          if (bi >= 0) {
            used.add(bi);
            const s = uSells[bi];
            insPair.run(buy.fill_id, s.fill_id, buy.price, s.price, Math.min(buy.size, s.size), bs * Math.min(buy.size, s.size));
          }
        }
        
        // Historical (pre Mar 12) + paired
        const hist = sdb.prepare("SELECT COALESCE(SUM(round_trip_profit), 0) as t FROM trades WHERE round_trip_profit > 0 AND created_at < '2026-03-12'").get() as any;
        const paired = sdb.prepare('SELECT COALESCE(SUM(profit), 0) as t, COUNT(*) as c FROM paired_roundtrips').get() as any;
        
        gridProfitNet = hist.t + paired.t;
        gridProfitTotal = gridProfitNet + REINVERSION;
        sdb.close();
        console.log(`💰 Grid profit: $${gridProfitNet.toFixed(2)} (hist=$${hist.t.toFixed(2)} + ${paired.c} pairs=$${paired.t.toFixed(2)}) total=$${gridProfitTotal.toFixed(2)}`);
      } catch (fillErr) {
        console.log(`⚠️ Grid profit calc failed: ${fillErr}`);
        gridProfitNet = bot.grid_profit_usdt || 0;
        gridProfitTotal = gridProfitNet + REINVERSION;
      }

      // Trend PnL = unrealized PnL from open position
      trendPnLGross = unrealizedPnl;
      
      console.log(`💰 [DEBUG] Bot ${botId} GRVT equity: $${grvtEquity.toFixed(2)}, balance: $${grvtBalance.toFixed(2)}, unrealized: $${unrealizedPnl.toFixed(2)}`);
      console.log(`💰 [DEBUG] Bot ${botId} grid profit (balance - investment): $${gridProfitNet.toFixed(2)}, fees: $${cumulativeFee.toFixed(4)}, funding: $${cumulativeFunding.toFixed(4)}`);
    } catch (summaryErr) {
      console.log(`⚠️ Error obteniendo account summary: ${summaryErr}`);
      gridProfitNet = bot.grid_profit_usdt || 0;
      trendPnLGross = bot.trend_pnl_usdt || 0;
    }
    
    const trendPnLNet = trendPnLGross - totalFunding;
    console.log(`💰 [DEBUG] Bot ${botId} trend PnL bruto: ${trendPnLGross}, neto: ${trendPnLNet}`);

    // 5. Total PnL = Grid Profit + Trend PnL (ambos ya netos)
    const totalPnLNet = gridProfitNet + trendPnLNet;
    console.log(`💰 [DEBUG] Bot ${botId} total PnL: ${totalPnLNet}`);

    return {
      gridProfit: gridProfitNet,
      gridProfitTotal: gridProfitTotal,
      trendPnL: trendPnLNet,
      totalPnL: totalPnLNet,
      totalFees: totalFees,
      totalFunding: totalFunding
    };

  } catch (error) {
    console.error(`❌ Error calculando PnL real para bot ${botId}:`, error);
    // Fallback: usar valores de DB sin corrección
    const bot = await db.getBot(botId);
    return {
      gridProfit: bot?.grid_profit_usdt || 0,
      gridProfitTotal: bot?.grid_profit_usdt || 0,
      trendPnL: bot?.trend_pnl_usdt || 0,
      totalPnL: bot?.total_pnl_usdt || 0,
      totalFees: 0,
      totalFunding: 0
    };
  }
}

// === GRACEFUL SHUTDOWN ===
process.on('SIGINT', async () => {
  console.log('\n🛑 Dashboard shutting down...');
  
  try {
    await gridEngine.stop();
    await db.close();
    console.log('✅ Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, shutting down gracefully (keeping orders on GRVT)...');
  // C.5: stop({ preserveOrders: true }) clears every interval, drains
  // in-flight poll tasks (fill archive, funding, compound), and skips
  // the bot-pause step so GRVT orders survive a container restart.
  try {
    await gridEngine.stop({ preserveOrders: true });
  } catch (stopErr) {
    console.error('❌ Error stopping engine during SIGTERM:', stopErr);
  }
  await db.close();
  console.log('✅ Shutdown limpio — órdenes preservadas en GRVT');
  process.exit(0);
});

// === START SERVER ===
async function startServer() {
  try {
    await initializeServices();

    // Wrap the express app in an explicit HTTP server so the v2 WebSocket
    // server can attach to the same port via the upgrade event.
    const httpServer = createServer(app);

    // Mount the v2 surface (WebSocket /ws + REST /api/v2/*) ONLY when an
    // API key is configured. This keeps the legacy server fully backwards-
    // compatible: deployments that don't set DASHBOARD_API_KEY skip v2
    // entirely.
    const apiKey = process.env.DASHBOARD_API_KEY;
    if (apiKey && apiKey.length >= 16) {
      mountV2({
        setRouter: setV2Router,
        httpServer,
        db: db.getRawDb(),
        gridBotDb: db,
        grvtClient,
        engine: gridEngine,
        apiKey
      });
      console.log(`🔌 v2 surface mounted: REST /api/v2/* + WebSocket /ws`);
    } else {
      console.log(`⚠️  v2 surface DISABLED (set DASHBOARD_API_KEY to a 16+ char string to enable)`);
    }

    httpServer.listen(PORT, () => {
      console.log('🔧 Edison: GRVT Grid Bot Dashboard - Fase 3');
      console.log(`🌐 Server: http://localhost:${PORT}`);
      console.log(`🔐 Auth: ${process.env.DASHBOARD_USER} / ${process.env.DASHBOARD_PASS}`);
      console.log(`💾 Database: SQLite WAL mode`);
      console.log(`🤖 Grid Engine: Listo (no iniciado automáticamente)`);
      console.log('🚀 Dashboard completo - ¡LISTO PARA TRADING!');
    });

  } catch (error) {
    console.error('❌ Failed to start dashboard server:', error);
    process.exit(1);
  }
}

startServer();