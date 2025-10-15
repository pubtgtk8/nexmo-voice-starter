import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import WebSocket from 'ws';
import { Vonage } from '@vonage/server-sdk';
import { Voice } from '@vonage/voice';
import { Auth } from '@vonage/auth';
import { logger } from './utils/logger';
import { CallHandler } from './handlers/call.handler';
import { TTSHandler } from './handlers/tts.handler';
import { RecordingHandler } from './handlers/recording.handler';
import { ConferenceHandler } from './handlers/conference.handler';
import { DTMFHandler } from './handlers/dtmf.handler';
import { WebSocketHandler } from './handlers/websocket.handler';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

class NexmoVoiceStarter {
  private app: express.Application;
  private vonage: Vonage;
  private voice: Voice;
  private callHandler: CallHandler;
  private ttsHandler: TTSHandler;
  private recordingHandler: RecordingHandler;
  private conferenceHandler: ConferenceHandler;
  private dtmfHandler: DTMFHandler;
  private webSocketHandler: WebSocketHandler;
  private wss: WebSocket.Server;
  private server: any;

  constructor() {
    this.initializeServices();
    this.initializeMiddleware();
    this.initializeRoutes();
    this.initializeWebSocket();
    this.initializeErrorHandling();
  }

  private initializeServices(): void {
    try {
      // Initialize Vonage client
      const auth = new Auth({
        apiKey: process.env.NEXMO_API_KEY!,
        apiSecret: process.env.NEXMO_API_SECRET!,
        privateKey: process.env.NEXMO_PRIVATE_KEY_PATH,
        applicationId: process.env.NEXMO_APPLICATION_ID,
      });

      this.vonage = new Vonage(auth);
      this.voice = new Voice(auth);

      // Initialize handlers
      this.callHandler = new CallHandler(this.vonage, this.voice);
      this.ttsHandler = new TTSHandler(this.vonage, this.voice);
      this.recordingHandler = new RecordingHandler(this.vonage, this.voice);
      this.conferenceHandler = new ConferenceHandler(this.vonage, this.voice);
      this.dtmfHandler = new DTMFHandler(this.vonage, this.voice);
      this.webSocketHandler = new WebSocketHandler();

      logger.info('All services initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize services:', error);
      throw error;
    }
  }

  private initializeMiddleware(): void {
    this.app = express();

    // Security middleware
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https:"],
        },
      },
    }));

    // CORS configuration
    this.app.use(cors({
      origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
      credentials: true,
    }));

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // File upload configuration
    const upload = multer({
      dest: process.env.UPLOAD_PATH || './uploads',
      limits: {
        fileSize: parseInt(process.env.UPLOAD_MAX_SIZE || '10485760'), // 10MB
      },
      fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('audio/')) {
          cb(null, true);
        } else {
          cb(new Error('Only audio files are allowed'));
        }
      }
    });

    this.app.use('/uploads', express.static('uploads'));
  }

  private initializeRoutes(): void {
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: '1.0.0',
      });
    });

    // Call management endpoints
    this.app.post('/api/calls/make', this.callHandler.makeCall.bind(this.callHandler));
    this.app.post('/api/calls/answer/:uuid', this.callHandler.answerCall.bind(this.callHandler));
    this.app.post('/api/calls/hangup/:uuid', this.callHandler.hangupCall.bind(this.callHandler));
    this.app.post('/api/calls/transfer/:uuid', this.callHandler.transferCall.bind(this.callHandler));
    this.app.get('/api/calls/:uuid', this.callHandler.getCallInfo.bind(this.callHandler));
    this.app.get('/api/calls', this.callHandler.getAllCalls.bind(this.callHandler));

    // Text-to-Speech endpoints
    this.app.post('/api/tts/speak', this.ttsHandler.speakText.bind(this.ttsHandler));
    this.app.post('/api/tts/stop/:uuid', this.ttsHandler.stopSpeech.bind(this.ttsHandler));
    this.app.get('/api/tts/voices', this.ttsHandler.getVoices.bind(this.ttsHandler));

    // Recording endpoints
    this.app.post('/api/recordings/start/:uuid', this.recordingHandler.startRecording.bind(this.recordingHandler));
    this.app.post('/api/recordings/stop/:uuid', this.recordingHandler.stopRecording.bind(this.recordingHandler));
    this.app.get('/api/recordings/:uuid', this.recordingHandler.getRecording.bind(this.recordingHandler));
    this.app.get('/api/recordings', this.recordingHandler.getAllRecordings.bind(this.recordingHandler));
    this.app.delete('/api/recordings/:uuid', this.recordingHandler.deleteRecording.bind(this.recordingHandler));

    // Conference endpoints
    this.app.post('/api/conferences/create', this.conferenceHandler.createConference.bind(this.conferenceHandler));
    this.app.post('/api/conferences/:id/join', this.conferenceHandler.joinConference.bind(this.conferenceHandler));
    this.app.post('/api/conferences/:id/leave', this.conferenceHandler.leaveConference.bind(this.conferenceHandler));
    this.app.post('/api/conferences/:id/mute', this.conferenceHandler.muteParticipant.bind(this.conferenceHandler));
    this.app.post('/api/conferences/:id/unmute', this.conferenceHandler.unmuteParticipant.bind(this.conferenceHandler));
    this.app.get('/api/conferences/:id', this.conferenceHandler.getConferenceInfo.bind(this.conferenceHandler));

    // DTMF endpoints
    this.app.post('/api/dtmf/send/:uuid', this.dtmfHandler.sendDTMF.bind(this.dtmfHandler));
    this.app.get('/api/dtmf/:uuid', this.dtmfHandler.getDTMF.bind(this.dtmfHandler));

    // Webhook endpoints
    this.app.post('/api/webhooks/answer', this.callHandler.handleAnswer.bind(this.callHandler));
    this.app.post('/api/webhooks/event', this.callHandler.handleEvent.bind(this.callHandler));
    this.app.post('/api/webhooks/recording', this.recordingHandler.handleRecordingWebhook.bind(this.recordingHandler));

    // File upload endpoint
    this.app.post('/api/upload', multer().single('audio'), (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      res.json({
        message: 'File uploaded successfully',
        filename: req.file.filename,
        originalname: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
      });
    });

    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Not Found',
        message: `Route ${req.originalUrl} not found`,
        availableRoutes: [
          'POST /api/calls/make',
          'POST /api/tts/speak',
          'POST /api/recordings/start/:uuid',
          'POST /api/conferences/create',
          'POST /api/dtmf/send/:uuid',
          'POST /api/upload',
        ],
      });
    });
  }

  private initializeWebSocket(): void {
    this.wss = new WebSocket.Server({ port: parseInt(process.env.WS_PORT || '3001') });

    this.wss.on('connection', (ws, req) => {
      logger.info('New WebSocket connection established');

      ws.on('message', (message) => {
        this.webSocketHandler.handleMessage(ws, message);
      });

      ws.on('close', () => {
        logger.info('WebSocket connection closed');
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
      });
    });

    logger.info(`WebSocket server started on port ${process.env.WS_PORT || '3001'}`);
  }

  private initializeErrorHandling(): void {
    this.app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.error('Unhandled error:', error);

      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          error: 'File too large',
          message: 'File size exceeds the maximum allowed size'
        });
      }

      res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    });
  }

  public async start(): Promise<void> {
    try {
      const port = parseInt(process.env.PORT || '3000');
      const host = process.env.HOST || '0.0.0.0';

      this.server = this.app.listen(port, host, () => {
        logger.info(`🚀 Nexmo Voice API Starter running on http://${host}:${port}`);
        logger.info(`📊 Health check: http://${host}:${port}/health`);
        logger.info(`🔗 API Base: http://${host}:${port}/api`);
        logger.info(`🔌 WebSocket: ws://${host}:${process.env.WS_PORT || '3001'}`);
      });

      // Graceful shutdown
      process.on('SIGTERM', () => this.gracefulShutdown('SIGTERM'));
      process.on('SIGINT', () => this.gracefulShutdown('SIGINT'));

    } catch (error) {
      logger.error('Failed to start server:', error);
      throw error;
    }
  }

  private async gracefulShutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}, starting graceful shutdown...`);

    if (this.server) {
      this.server.close((err: Error | undefined) => {
        if (err) {
          logger.error('Error during server shutdown:', err);
          process.exit(1);
        }

        logger.info('Server shutdown complete');
        process.exit(0);
      });
    }

    if (this.wss) {
      this.wss.close();
    }
  }

  public getApp(): express.Application {
    return this.app;
  }

  public getVonage(): Vonage {
    return this.vonage;
  }

  public getVoice(): Voice {
    return this.voice;
  }

  public getWebSocketServer(): WebSocket.Server {
    return this.wss;
  }
}

// Main execution
async function main(): Promise<void> {
  try {
    const app = new NexmoVoiceStarter();
    await app.start();
  } catch (error) {
    console.error('Failed to start Nexmo Voice API Starter:', error);
    process.exit(1);
  }
}

// Start the application if this file is run directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Application startup failed:', error);
    process.exit(1);
  });
}

export { NexmoVoiceStarter };