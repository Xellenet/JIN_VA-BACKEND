import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('healthCheck', () => {
    it('should return { status: "ok" }', () => {
      expect(appController.healthCheck()).toEqual({ status: 'ok' });
    });
  });

  describe('AppService', () => {
    it('should return "Hello World!"', () => {
      const appService = new AppService();
      expect(appService.getHello()).toBe('Hello World!');
    });
  });
});
