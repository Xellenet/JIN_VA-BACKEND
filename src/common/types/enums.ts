export enum Role{
    CUSTOMER = 'CUSTOMER',
    ADMIN = 'ADMIN',
    ARTISAN = 'ARTISAN'
}

export enum Gender{
    MALE = 'MALE',
    FEMALE = 'FEMALE',
    OTHER = 'OTHER'
}

export enum Token {
    VERIFICATION = 'VERIFICATION',
    EMAIL_VERIFICATION = 'EMAIL_VERIFICATION',
    PASSWORD_RESET = 'PASSWORD_RESET',
    REFRESH = 'REFRESH'
}

export enum Status {
    OPEN = 'OPEN',
    PENDING = 'PENDING',
    IN_PROGRESS = 'IN_PROGRESS',
    COMPLETED = 'COMPLETED',
    CANCELLED = 'CANCELLED',
    EXPIRED = 'EXPIRED'
}