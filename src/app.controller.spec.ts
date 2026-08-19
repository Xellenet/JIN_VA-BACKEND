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

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });
describe('AppController additional tests', () => {
  let appController: AppController;
  let appService: AppService;

  beforeEach(() => {
    appService = { getHello: jest.fn().mockReturnValue('Mocked Hello') } as any;
    appController = new AppController(appService);
  });

  it('should be defined', () => {
    expect(appController).toBeDefined();
  });

  it('should call appService.getHello and return its value', () => {
    const result = appController.getHello();
    expect(appService.getHello).toHaveBeenCalled();
    expect(result).toBe('Mocked Hello');
  });
});
});
