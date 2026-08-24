/** The parts of a scroll container this module needs, so it can be tested
    without a DOM. */
export interface ScrollBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Whether a transcript is parked at its bottom edge. The slack absorbs the
 * fractional scrollTop browsers report at zoom levels other than 100%, where an
 * exact comparison would read as "scrolled up" and unpin a transcript nobody
 * touched.
 */
export function isAtBottom(box: ScrollBox, slack = 40): boolean {
  return box.scrollHeight - box.clientHeight - box.scrollTop <= slack;
}
