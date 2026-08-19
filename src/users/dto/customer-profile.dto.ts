import { PartialType } from "@nestjs/swagger";
import { User } from "@users/entities/user.entity";
import { UserResponseDto } from "./user-response.dto";

export class CustomerProfileDto{
    budgetMin?: number;
    budgetMax?: number;
    preferredServices?: string[];
    bio?: string;
    user: UserResponseDto;
    createdAt: Date;
    updatedAt: Date;

}