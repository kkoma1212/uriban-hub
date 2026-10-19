// 목록 화면이 돌아올 위치(쪽 묶음)를 기억하는 데 쓰는 형태만 남긴다. 옛 쪽 넘김 부품
// (useContentPages·readContentPage·ContentPagination)은 화면 개편 뒤 쓰이지 않아 지웠다(총검수 D2-05·D5-09).
interface PageBookmark {
  cursor: string | undefined;
  offset: number;
  start: number;
}
export interface ContentPageSnapshot {
  index: number;
  pages: PageBookmark[];
}

export function contentPageCursor(snapshot: ContentPageSnapshot | undefined): string | undefined {
  return snapshot?.pages[snapshot.index]?.cursor;
}
