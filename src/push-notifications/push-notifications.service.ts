import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DeviceToken } from './entities/device-token.entity';
import { NotificationPreferences } from '../notifications/entities/notification-preferences.entity';
import { PushProviderFactory } from './providers/push-provider.factory';
import { RegisterDeviceDto } from './dto/register-device.dto';
import type { PushPayload } from './providers/push-provider.interface';

@Injectable()
export class PushNotificationsService {
  private readonly logger = new Logger(PushNotificationsService.name);

  constructor(
    @InjectRepository(DeviceToken)
    private readonly deviceTokensRepository: Repository<DeviceToken>,
    @InjectRepository(NotificationPreferences)
    private readonly prefsRepository: Repository<NotificationPreferences>,
    private readonly factory: PushProviderFactory,
  ) {}

  async registerDevice(userId: number, dto: RegisterDeviceDto): Promise<{ message: string }> {
    const existing = await this.deviceTokensRepository.findOne({
      where: { token: dto.token },
    });

    if (existing) {
      // Re-associate with the current user in case the device was reassigned
      existing.userId = userId;
      existing.platform = dto.platform;
      await this.deviceTokensRepository.save(existing);
    } else {
      const record = this.deviceTokensRepository.create({ ...dto, userId });
      await this.deviceTokensRepository.save(record);
    }

    this.logger.log(`Device registered for user ${userId} [${dto.platform}]`);
    return { message: 'Device registered for push notifications.' };
  }

  async unregisterDevice(userId: number, token: string): Promise<{ message: string }> {
    await this.deviceTokensRepository.delete({ userId, token });
    this.logger.log(`Device unregistered for user ${userId}`);
    return { message: 'Device unregistered.' };
  }

  async sendToUser(userId: number, payload: PushPayload): Promise<void> {
    const prefs = await this.prefsRepository.findOne({ where: { user: { id: userId } } });

    // If preferences row doesn't exist or push is disabled, skip
    if (prefs && !prefs.pushEnabled) return;

    const deviceTokens = await this.deviceTokensRepository.find({
      where: { userId },
      select: ['token'],
    });

    if (!deviceTokens.length) return;

    const tokens = deviceTokens.map((d) => d.token);
    const result = await this.factory.get().send(tokens, payload);

    // Prune stale tokens returned by FCM
    if (result.failedTokens.length) {
      await this.deviceTokensRepository.delete({ token: In(result.failedTokens) });
      this.logger.warn(`Pruned ${result.failedTokens.length} stale token(s) for user ${userId}`);
    }
  }
}
