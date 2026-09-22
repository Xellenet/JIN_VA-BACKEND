import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose, Type } from 'class-transformer';
import { Gender, Role } from '@common/types/enums';
import { AddressResponseDto } from './address-response.dto';

/**
 * The only user shape any response is allowed to carry.
 *
 * **Every field here is `@Expose()`d deliberately, and every serialisation site
 * must pass `{ excludeExtraneousValues: true }`.** Both halves are load-bearing
 * and they close different holes:
 *
 * - Without the option, class-transformer copies *every* own property of the
 *   source `User` entity onto the instance, so the whole moderation state
 *   (`isBanned`, `bannedAt`, `bannedById`, `isSuspended`, `suspendedAt`,
 *   `suspendedById`, `suspensionReason` — which the entity itself documents as
 *   "shown to the admin, not to the user") plus `deletedAt`, `purgedAt`,
 *   `createdAt` and `updatedAt` were serialised on every auth response. The
 *   `@Exclude()` decorators on the entity have no effect here: the transform
 *   *target* is this DTO, not the entity.
 * - There used to be a declared `password` property as well, and it was not
 *   empty in practice — `createUser` and `changePassword` both hand back an
 *   in-memory entity that still carries the freshly-computed bcrypt hash
 *   regardless of the column's `select: false`, so `POST /auth/register` and
 *   `POST /auth/change-password` returned the hash of the password the caller
 *   had just typed. It is removed from the class outright rather than only
 *   filtered at the call sites, so a future site that forgets the option still
 *   cannot leak credential material.
 *
 * Adding a field here is a contract change: it must be `@Expose()`d
 * intentionally and documented in `api-contract.md`, never inherited from the
 * entity by accident.
 *
 * The class-level `@Exclude()` is the structural half, and it is not
 * decoration: deleting the `password` property alone does **not** stop a
 * call site that forgets `excludeExtraneousValues` from leaking the hash,
 * because class-transformer copies every own property of the *source* object
 * when that option is off (verified — it emitted
 * `{"password":"$2b$…","isBanned":true}` from a plain source). `@Exclude()` on
 * the class switches the strategy to "exclude everything not explicitly
 * `@Expose()`d", which holds regardless of what any call site passes.
 */
@Exclude()
export class UserResponseDto {
  @ApiProperty({ example: 1, description: 'Unique identifier of the user' })
  @Expose()
  id: number;

  @ApiProperty({
    example: 'john@example.com',
    description: 'User email address',
  })
  @Expose()
  email: string;

  @ApiProperty({
    example: 'johndoe',
    description: 'User username',
    nullable: true,
  })
  @Expose()
  username: string;

  @ApiProperty({ example: 'John', description: 'User first name' })
  @Expose()
  firstname: string;

  @ApiProperty({ example: 'Doe', description: 'User last name' })
  @Expose()
  lastname: string;

  @ApiProperty({
    example: 'MALE',
    description: 'User gender',
    enum: Gender,
    enumName: 'Gender',
  })
  @Expose()
  gender: Gender;

  @ApiProperty({
    example: 'CUSTOMER',
    description: 'User role',
    enum: Role,
    enumName: 'Role',
  })
  @Expose()
  role: Role;

  @ApiProperty({ example: '123-456-7890', description: 'User phone number' })
  @Expose()
  phoneNumber: string;

  @ApiProperty({
    example: 'https://api.example.com/uploads/avatars/abc.jpg',
    description: 'Profile picture URL',
    nullable: true,
  })
  @Expose()
  profilePicture?: string;

  @ApiProperty({
    example: true,
    description: 'Whether the account email has been verified',
  })
  @Expose()
  accountVerified: boolean;

  @ApiProperty({
    description: 'User addresses',
    type: [AddressResponseDto],
    required: false,
  })
  @Expose()
  @Type(() => AddressResponseDto)
  addresses?: AddressResponseDto[];
}
