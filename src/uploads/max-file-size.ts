import { MaxFileSizeValidator } from '@nestjs/common';

const MB = 1024 * 1024;

/**
 * A file size limit with a message people can read. QA UP-02: the default
 * was "Validation failed (current file size is 4194949, expected size is less
 * than 3145728)".
 */
export function maxFileSizeMb(megabytes: number): MaxFileSizeValidator {
  return new MaxFileSizeValidator({
    maxSize: megabytes * MB,
    errorMessage: `That file is too large. The limit is ${megabytes} MB.`,
  });
}
