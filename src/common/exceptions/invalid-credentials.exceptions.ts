import { HttpException } from "@nestjs/common";

export class InvalidCredentialsException extends HttpException {
    constructor(message: string) {
        super(message, 401);
    }
}
