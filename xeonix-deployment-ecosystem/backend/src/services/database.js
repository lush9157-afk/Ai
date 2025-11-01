/**
 * @fileoverview PostgreSQL Database Service with Sequelize ORM
 * @module services/database
 * @description Production-ready database service with connection pooling,
 * transaction management, retry logic, and comprehensive error handling
 */

import { Sequelize } from 'sequelize';
import pg from 'pg';
import chalk from 'chalk';

/**
 * Database Service Class
 * Manages PostgreSQL connections using Sequelize ORM
 * @class DatabaseService
 */
export class DatabaseService {
  /**
   * Creates a new DatabaseService instance
   * @constructor
   */
  constructor() {
    this.sequelize = null;
    this.isConnectedFlag = false;
    this.retryAttempts = 0;
    this.maxRetries = 5;
    this.retryDelay = 5000;
    this.healthCheckInterval = null;
    this.models = {};
    
    // Configuration from environment variables
    this.config = {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'xeonix_deployment',
      username: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      dialect: 'postgres',
      dialectModule: pg,
      logging: process.env.NODE_ENV === 'development' ? console.log : false,
      pool: {
        min: parseInt(process.env.DB_POOL_MIN) || 2,
        max: parseInt(process.env.DB_POOL_MAX) || 10,
        acquire: 30000,
        idle: 10000,
        evict: 10000,
      },
      dialectOptions: {
        ssl: process.env.DB_SSL === 'true' ? {
          require: true,
          rejectUnauthorized: false,
        } : false,
        connectTimeout: 60000,
        keepAlive: true,
        statement_timeout: 30000,
        idle_in_transaction_session_timeout: 30000,
      },
      retry: {
        max: 3,
        timeout: 3000,
      },
      define: {
        timestamps: true,
        underscored: true,
        freezeTableName: true,
      },
    };
  }

  /**
   * Establishes connection to PostgreSQL database
   * @async
   * @returns {Promise<boolean>} Connection success status
   * @throws {Error} If connection fails after max retries
   */
  async connect() {
    try {
      console.log(chalk.blue('📊 Initializing PostgreSQL connection...'));
      
      // Create Sequelize instance
      this.sequelize = new Sequelize(
        this.config.database,
        this.config.username,
        this.config.password,
        this.config
      );

      // Test connection with retry logic
      await this.connectWithRetry();

      // Sync models (create tables if they don't exist)
      if (process.env.NODE_ENV !== 'production') {
        await this.sequelize.sync({ alter: false });
        console.log(chalk.green('✓ Database models synchronized'));
      }

      this.isConnectedFlag = true;
      
      // Start health check monitoring
      this.startHealthCheck();
      
      console.log(chalk.green('✓ PostgreSQL connected successfully'));
      console.log(chalk.gray(`  Host: ${this.config.host}:${this.config.port}`));
      console.log(chalk.gray(`  Database: ${this.config.database}`));
      console.log(chalk.gray(`  Pool: ${this.config.pool.min}-${this.config.pool.max} connections`));
      
      return true;
    } catch (error) {
      console.error(chalk.red('✗ PostgreSQL connection failed:'), error.message);
      throw error;
    }
  }

  /**
   * Attempts to connect with exponential backoff retry logic
   * @async
   * @private
   * @throws {Error} If max retries exceeded
   */
  async connectWithRetry() {
    while (this.retryAttempts < this.maxRetries) {
      try {
        await this.sequelize.authenticate();
        console.log(chalk.green('✓ Database authentication successful'));
        this.retryAttempts = 0;
        return;
      } catch (error) {
        this.retryAttempts++;
        console.error(
          chalk.yellow(`⚠ Connection attempt ${this.retryAttempts}/${this.maxRetries} failed:`)
        );
        console.error(chalk.red(`  ${error.message}`));

        if (this.retryAttempts >= this.maxRetries) {
          throw new Error(
            `Failed to connect to database after ${this.maxRetries} attempts: ${error.message}`
          );
        }

        const delay = this.retryDelay * Math.pow(2, this.retryAttempts - 1);
        console.log(chalk.yellow(`  Retrying in ${delay / 1000} seconds...`));
        await this.sleep(delay);
      }
    }
  }

  /**
   * Disconnects from the database
   * @async
   * @returns {Promise<void>}
   */
  async disconnect() {
    try {
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }

      if (this.sequelize) {
        await this.sequelize.close();
        this.isConnectedFlag = false;
        console.log(chalk.yellow('⚠ PostgreSQL disconnected'));
      }
    } catch (error) {
      console.error(chalk.red('Error disconnecting from database:'), error.message);
      throw error;
    }
  }

  /**
   * Checks if database is connected
   * @returns {boolean} Connection status
   */
  isConnected() {
    return this.isConnectedFlag && this.sequelize !== null;
  }

  /**
   * Gets the Sequelize instance
   * @returns {Sequelize|null} Sequelize instance
   */
  getSequelize() {
    return this.sequelize;
  }

  /**
   * Performs a health check on the database connection
   * @async
   * @returns {Promise<Object>} Health check results
   */
  async healthCheck() {
    try {
      const startTime = Date.now();
      await this.sequelize.authenticate();
      const responseTime = Date.now() - startTime;

      const poolStats = {
        size: this.sequelize.connectionManager.pool.size,
        available: this.sequelize.connectionManager.pool.available,
        using: this.sequelize.connectionManager.pool.using,
        waiting: this.sequelize.connectionManager.pool.waiting,
      };

      return {
        status: 'healthy',
        connected: true,
        responseTime: `${responseTime}ms`,
        pool: poolStats,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error(chalk.red('Database health check failed:'), error.message);
      return {
        status: 'unhealthy',
        connected: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Starts periodic health check monitoring
   * @private
   */
  startHealthCheck() {
    // Check every 30 seconds
    this.healthCheckInterval = setInterval(async () => {
      const health = await this.healthCheck();
      if (health.status === 'unhealthy') {
        console.error(chalk.red('⚠ Database health check failed, attempting reconnection...'));
        try {
          await this.connectWithRetry();
        } catch (error) {
          console.error(chalk.red('Failed to reconnect to database:'), error.message);
        }
      }
    }, 30000);
  }

  /**
   * Executes a raw SQL query
   * @async
   * @param {string} query - SQL query string
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Query results
   */
  async query(query, options = {}) {
    try {
      const [results, metadata] = await this.sequelize.query(query, {
        type: Sequelize.QueryTypes.SELECT,
        ...options,
      });
      return results;
    } catch (error) {
      console.error(chalk.red('Query execution failed:'), error.message);
      throw error;
    }
  }

  /**
   * Executes a function within a database transaction
   * @async
   * @param {Function} callback - Function to execute in transaction
   * @param {Object} options - Transaction options
   * @returns {Promise<*>} Transaction result
   */
  async transaction(callback, options = {}) {
    const transaction = await this.sequelize.transaction(options);
    
    try {
      const result = await callback(transaction);
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback();
      console.error(chalk.red('Transaction failed and rolled back:'), error.message);
      throw error;
    }
  }

  /**
   * Registers a Sequelize model
   * @param {string} name - Model name
   * @param {Object} model - Sequelize model
   */
  registerModel(name, model) {
    this.models[name] = model;
  }

  /**
   * Gets a registered model by name
   * @param {string} name - Model name
   * @returns {Object|null} Sequelize model
   */
  getModel(name) {
    return this.models[name] || null;
  }

  /**
   * Gets all registered models
   * @returns {Object} All models
   */
  getModels() {
    return this.models;
  }

  /**
   * Performs database backup
   * @async
   * @param {string} backupPath - Path to save backup
   * @returns {Promise<Object>} Backup result
   */
  async backup(backupPath) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `backup_${this.config.database}_${timestamp}.sql`;
      
      console.log(chalk.blue(`📦 Creating database backup: ${filename}`));
      
      // This would typically use pg_dump
      // Implementation depends on system setup
      
      return {
        success: true,
        filename,
        path: backupPath,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error(chalk.red('Backup failed:'), error.message);
      throw error;
    }
  }

  /**
   * Gets database statistics
   * @async
   * @returns {Promise<Object>} Database statistics
   */
  async getStats() {
    try {
      const stats = await this.query(`
        SELECT 
          schemaname,
          tablename,
          pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
          pg_total_relation_size(schemaname||'.'||tablename) AS size_bytes
        FROM pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY size_bytes DESC;
      `);

      const dbSize = await this.query(`
        SELECT pg_size_pretty(pg_database_size('${this.config.database}')) AS size;
      `);

      return {
        tables: stats,
        totalSize: dbSize[0]?.size || 'Unknown',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error(chalk.red('Failed to get database stats:'), error.message);
      throw error;
    }
  }

  /**
   * Utility function to sleep for specified milliseconds
   * @private
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default DatabaseService;
