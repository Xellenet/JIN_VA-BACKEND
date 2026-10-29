import { asSentence } from './notifications.service';

/** QA NOT-07: "Image is too small.. You can resubmit" */
describe('asSentence', () => {
  it.each([
    [
      'Image is too small to show the work.',
      'Image is too small to show the work.',
    ],
    [
      'Image is too small to show the work',
      'Image is too small to show the work.',
    ],
    ['  Is this your work?  ', 'Is this your work?'],
    ['Blurry photo!', 'Blurry photo!'],
  ])('%p → %p', (input, expected) => {
    expect(asSentence(input)).toBe(expected);
  });
});
