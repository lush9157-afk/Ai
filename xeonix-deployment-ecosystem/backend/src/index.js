import 'dotenv/config';
import { Client, GatewayIntentBits, Collection, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } from 'discord.js';
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import chalk from 'chalk';
import figlet from 'figlet';
import ora from 'ora';

// Import services
import { DatabaseService } from './services/database.js';
import { RedisService } from './services/redis.js';
import { DockerService } from './services/docker/DockerService.js';
import { LXCService } from './services/lxc/LXCService.js';
import { NATService } from './services/nat/NATService.js';
import { VPSService } from './services/vps/VPSService.js';
import { MonitoringService } from './services/monitoring/MonitoringService.js';
import { BillingService } from './services/billing/BillingService.js';
import { ShopService } from './services/shop/ShopService.js';
import { GameServerService } from './services/gameserver/GameServerService.js';
import { NotificationService } from './services/notifications/NotificationService.js';
import { WebSocketService } from './services/websocket/WebSocketService.js';
import { Logger } from './utils/logger.js';
import { CommandHandler } from './utils/commandHandler.js';
import { EventHandler } from './utils/eventHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class XeonixDeploymentBot {
  constructor() {
    this.client = null;
    this.app = null;
    this.server = null;
    this.io = null;
    this.services = {};
    this.logger = new Logger();
    this.isReady = false;
  }

  async initialize() {
    try {
      // Display banner
      this.displayBanner();

      // Initialize Discord Client
      const spinner = ora('Initializing Discord Bot...').start();
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildPresences,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.GuildMessageReactions,
          GatewayIntentBits.GuildVoiceStates,
        ],
        partials: ['MESSAGE', 'CHANNEL', 'REACTION', 'USER'],
      });

      this.client.commands = new Collection();
      this.client.cooldowns = new Collection();
      spinner.succeed('Discord Client initialized');

      // Initialize Database
      spinner.start('Connecting to PostgreSQL...');
      this.services.database = new DatabaseService();
      await this.services.database.connect();
      spinner.succeed('PostgreSQL connected');

      // Initialize Redis
      spinner.start('Connecting to Redis...');
      this.services.redis = new RedisService();
      await this.services.redis.connect();
      spinner.succeed('Redis connected');

      // Initialize Core Services
      spinner.start('Initializing core services...');
      this.services.docker = new DockerService();
      this.services.lxc = new LXCService();
      this.services.nat = new NATService();
      this.services.vps = new VPSService(this.services);
      this.services.monitoring = new MonitoringService(this.services);
      this.services.billing = new BillingService(this.services);
      this.services.shop = new ShopService(this.services);
      this.services.gameserver = new GameServerService(this.services);
      this.services.notification = new NotificationService(this.services);
      spinner.succeed('Core services initialized');

      // Load Commands
      spinner.start('Loading commands...');
      await this.loadCommands();
      spinner.succeed(`Loaded ${this.client.commands.size} commands`);

      // Load Events
      spinner.start('Loading events...');
      await this.loadEvents();
      spinner.succeed('Events loaded');

      // Initialize Express API
      spinner.start('Starting API server...');
      await this.initializeAPI();
      spinner.succeed(`API server running on port ${process.env.API_PORT || 3000}`);

      // Initialize WebSocket
      spinner.start('Starting WebSocket server...');
      this.services.websocket = new WebSocketService(this.io, this.services);
      await this.services.websocket.initialize();
      spinner.succeed('WebSocket server initialized');

      // Login to Discord
      spinner.start('Logging in to Discord...');
      await this.client.login(process.env.DISCORD_BOT_TOKEN);
      spinner.succeed('Successfully logged in to Discord');

      this.isReady = true;
      this.logger.info('🚀 Xeonix Deployment Bot is fully operational!');
    } catch (error) {
      this.logger.error('Failed to initialize bot:', error);
      process.exit(1);
    }
  }

  displayBanner() {
    console.clear();
    console.log(chalk.cyan(figlet.textSync('XEONIX', { horizontalLayout: 'full' })));
    console.log(chalk.yellow('═'.repeat(80)));
    console.log(chalk.green('  🚀 Enterprise VPS Management Ecosystem'));
    console.log(chalk.green('  📦 Version: 1.0.0'));
    console.log(chalk.green('  🔧 Production Ready'));
    console.log(chalk.yellow('═'.repeat(80)));
    console.log('');
  }

  async loadCommands() {
    const commandFolders = [
      'vps', 'network', 'storage', 'security', 'monitoring',
      'shop', 'admin', 'gameserver', 'utility'
    ];

    for (const folder of commandFolders) {
      const commandPath = join(__dirname, 'commands', folder);
      try {
        const commandFiles = await fs.readdir(commandPath);
        for (const file of commandFiles.filter(f => f.endsWith('.js'))) {
          const filePath = join(commandPath, file);
          const command = await import(`file://${filePath}`);
          if (command.default && command.default.data && command.default.execute) {
            this.client.commands.set(command.default.data.name, command.default);
          }
        }
      } catch (error) {
        this.logger.warn(`Could not load commands from ${folder}:`, error.message);
      }
    }
  }

  async loadEvents() {
    const eventHandler = new EventHandler(this.client, this.services);
    await eventHandler.loadEvents();
  }

  async initializeAPI() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = new SocketIOServer(this.server, {
      cors: {
        origin: process.env.CORS_ORIGIN?.split(',') || '*',
        credentials: true,
      },
    });

    // Middleware
    this.app.use(helmet());
    this.app.use(cors({
      origin: process.env.CORS_ORIGIN?.split(',') || '*',
      credentials: true,
    }));
    this.app.use(compression());
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    this.app.use(morgan('combined', { stream: { write: msg => this.logger.info(msg.trim()) } }));

    // Rate limiting
    const limiter = rateLimit({
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
      max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
      message: 'Too many requests from this IP, please try again later.',
    });
    this.app.use('/api/', limiter);

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        services: {
          database: this.services.database.isConnected(),
          redis: this.services.redis.isConnected(),
          discord: this.client.isReady(),
        },
      });
    });

    // API Routes
    this.app.use('/api/vps', (await import('./services/api/vpsRoutes.js')).default(this.services));
    this.app.use('/api/network', (await import('./services/api/networkRoutes.js')).default(this.services));
    this.app.use('/api/storage', (await import('./services/api/storageRoutes.js')).default(this.services));
    this.app.use('/api/security', (await import('./services/api/securityRoutes.js')).default(this.services));
    this.app.use('/api/monitoring', (await import('./services/api/monitoringRoutes.js')).default(this.services));
    this.app.use('/api/shop', (await import('./services/api/shopRoutes.js')).default(this.services));
    this.app.use('/api/billing', (await import('./services/api/billingRoutes.js')).default(this.services));
    this.app.use('/api/gameserver', (await import('./services/api/gameserverRoutes.js')).default(this.services));
    this.app.use('/api/admin', (await import('./services/api/adminRoutes.js')).default(this.services));

    // Error handling
    this.app.use((err, req, res, next) => {
      this.logger.error('API Error:', err);
      res.status(err.status || 500).json({
        error: {
          message: err.message || 'Internal Server Error',
          status: err.status || 500,
        },
      });
    });

    // Start server
    const port = process.env.API_PORT || 3000;
    await new Promise((resolve) => {
      this.server.listen(port, process.env.API_HOST || '0.0.0.0', resolve);
    });
  }

  async shutdown() {
    this.logger.info('Shutting down gracefully...');
    
    if (this.client) {
      await this.client.destroy();
    }
    
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
    }
    
    if (this.services.database) {
      await this.services.database.disconnect();
    }
    
    if (this.services.redis) {
      await this.services.redis.disconnect();
    }
    
    this.logger.info('Shutdown complete');
    process.exit(0);
  }
}

// Initialize and start the bot
const bot = new XeonixDeploymentBot();

// Handle shutdown signals
process.on('SIGINT', () => bot.shutdown());
process.on('SIGTERM', () => bot.shutdown());
process.on('unhandledRejection', (error) => {
  bot.logger.error('Unhandled Promise Rejection:', error);
});
process.on('uncaughtException', (error) => {
  bot.logger.error('Uncaught Exception:', error);
  bot.shutdown();
});

// Start the bot
bot.initialize().catch((error) => {
  console.error('Fatal error during initialization:', error);
  process.exit(1);
});

export default bot;
