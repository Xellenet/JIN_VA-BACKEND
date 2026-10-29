import { VerificationController } from './verification.controller';
import type { VerificationService } from './verification.service';
import type { User } from '@users/entities/user.entity';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';
import type { SubmitVerificationDto } from './dto/submit-verification.dto';
import { DocumentType, Role, VerificationStatus } from '@common/types/enums';

describe('VerificationController', () => {
  let controller: VerificationController;

  const mockService = {
    submit: jest.fn(),
    getMyVerification: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    startReview: jest.fn(),
    approve: jest.fn(),
    reject: jest.fn(),
  };

  const artisan = {
    id: 7,
    email: 'artisan@example.com',
    role: Role.ARTISAN,
  } as User;
  const admin = {
    id: 99,
    email: 'admin@example.com',
    role: Role.ADMIN,
  } as User;
  const reqAs = (user: User) => ({ user }) as AuthenticatedRequest;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new VerificationController(
      mockService as unknown as VerificationService,
    );
  });

  it('submit forwards the caller id and DTO and returns the service result', async () => {
    const dto = {
      documentType: DocumentType.PASSPORT,
      documentFrontUrl: 'https://cdn.example.com/front.jpg',
      selfieUrl: 'https://cdn.example.com/selfie.jpg',
    } as SubmitVerificationDto;
    const response = { message: 'ok', data: { id: 1 } };
    mockService.submit.mockResolvedValue(response);

    await expect(controller.submit(reqAs(artisan), dto)).resolves.toBe(
      response,
    );
    expect(mockService.submit).toHaveBeenCalledWith(7, dto);
  });

  it('getMyVerification looks up the caller', async () => {
    const response = { message: 'ok', data: { id: 1 } };
    mockService.getMyVerification.mockResolvedValue(response);

    await expect(controller.getMyVerification(reqAs(artisan))).resolves.toBe(
      response,
    );
    expect(mockService.getMyVerification).toHaveBeenCalledWith(7);
  });

  it('findAll passes the query through', async () => {
    const query = { status: VerificationStatus.PENDING, page: 2, limit: 5 };
    const response = { message: 'ok', data: [], pagination: {} };
    mockService.findAll.mockResolvedValue(response);

    await expect(controller.findAll(query)).resolves.toBe(response);
    expect(mockService.findAll).toHaveBeenCalledWith(query);
  });

  it('findOne passes the id through', async () => {
    const response = { message: 'ok', data: { id: 11 } };
    mockService.findOne.mockResolvedValue(response);

    await expect(controller.findOne(11)).resolves.toBe(response);
    expect(mockService.findOne).toHaveBeenCalledWith(11);
  });

  it('startReview passes the admin id and record id', async () => {
    const response = { message: 'started' };
    mockService.startReview.mockResolvedValue(response);

    await expect(controller.startReview(reqAs(admin), 11)).resolves.toBe(
      response,
    );
    expect(mockService.startReview).toHaveBeenCalledWith(99, 11);
  });

  it('approve passes the full admin user (for the audit snapshot)', async () => {
    const dto = { notes: 'Looks good' };
    const response = { message: 'approved' };
    mockService.approve.mockResolvedValue(response);

    await expect(controller.approve(reqAs(admin), 11, dto)).resolves.toBe(
      response,
    );
    expect(mockService.approve).toHaveBeenCalledWith(admin, 11, dto);
  });

  it('reject passes the full admin user, id and reason', async () => {
    const dto = { reason: 'Expired document' };
    const response = { message: 'rejected' };
    mockService.reject.mockResolvedValue(response);

    await expect(controller.reject(reqAs(admin), 11, dto)).resolves.toBe(
      response,
    );
    expect(mockService.reject).toHaveBeenCalledWith(admin, 11, dto);
  });

  it('propagates service errors unchanged', async () => {
    const error = new Error('boom');
    mockService.findOne.mockRejectedValue(error);

    await expect(controller.findOne(1)).rejects.toBe(error);
  });
});
