import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';
import { AvailabilityStatus } from '@common/types/enums';
import { AvailabilityController } from './availability.controller';
import type { AvailabilityService } from './availability.service';

describe('AvailabilityController', () => {
  const req = { user: { id: 90 } } as unknown as AuthenticatedRequest;
  const result = { message: 'ok' };
  let service: Record<string, jest.Mock>;
  let controller: AvailabilityController;

  beforeEach(() => {
    service = Object.fromEntries(
      [
        'getMyAvailability',
        'setStatus',
        'addSlot',
        'updateSlot',
        'removeSlot',
        'addBlock',
        'listMyBlocks',
        'removeBlock',
        'getArtisanAvailability',
      ].map((m) => [m, jest.fn().mockResolvedValue(result)]),
    );
    controller = new AvailabilityController(
      service as unknown as AvailabilityService,
    );
  });

  it('scopes every self-management call to the authenticated user', async () => {
    const statusDto = { status: AvailabilityStatus.BUSY };
    const slotDto = { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' };
    const patchDto = { isActive: false };
    const blockDto = { startDate: '2026-11-01', endDate: '2026-11-07' };

    await expect(controller.getMyAvailability(req)).resolves.toBe(result);
    await expect(controller.setStatus(req, statusDto)).resolves.toBe(result);
    await expect(controller.addSlot(req, slotDto as never)).resolves.toBe(
      result,
    );
    await expect(
      controller.updateSlot(req, 501, patchDto as never),
    ).resolves.toBe(result);
    await expect(controller.removeSlot(req, 501)).resolves.toBe(result);
    await expect(controller.addBlock(req, blockDto as never)).resolves.toBe(
      result,
    );
    await expect(controller.listMyBlocks(req)).resolves.toBe(result);
    await expect(controller.removeBlock(req, 77)).resolves.toBe(result);

    expect(service.getMyAvailability).toHaveBeenCalledWith(90);
    expect(service.setStatus).toHaveBeenCalledWith(90, statusDto);
    expect(service.addSlot).toHaveBeenCalledWith(90, slotDto);
    expect(service.updateSlot).toHaveBeenCalledWith(90, 501, patchDto);
    expect(service.removeSlot).toHaveBeenCalledWith(90, 501);
    expect(service.addBlock).toHaveBeenCalledWith(90, blockDto);
    expect(service.listMyBlocks).toHaveBeenCalledWith(90);
    expect(service.removeBlock).toHaveBeenCalledWith(90, 77);
  });

  it('passes the profile id and optional date to the public read', async () => {
    await expect(
      controller.getArtisanAvailability(30, { date: '2026-11-02' }),
    ).resolves.toBe(result);
    expect(service.getArtisanAvailability).toHaveBeenCalledWith(
      30,
      '2026-11-02',
    );

    await controller.getArtisanAvailability(31, {});
    expect(service.getArtisanAvailability).toHaveBeenLastCalledWith(
      31,
      undefined,
    );
  });
});
