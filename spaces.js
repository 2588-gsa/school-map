// =============================================================
//  학교 공간 데이터 (지도는 전부 이 파일을 보고 그려집니다)
//  ※ 지금은 "예시 데이터"입니다. 실제 학교 배치로 교체하세요.
//
//  좌표 단위: 지도 그림 안에서의 위치 (x: 왼쪽→오른쪽, y: 위→아래)
//  - 캠퍼스 지도 크기: campus.width × campus.height
//  - 층별 지도 크기:   floorSize.width × floorSize.height
//  좌표는 index.html?edit=1 로 열어서 드래그하면 쉽게 얻을 수 있어요.
// =============================================================

const MAP_DATA = {
  campus: {
    width: 1000,
    height: 600,
    // 클릭 안 되는 배경 요소 (운동장, 길 등)
    decor: [
      { label: "운동장", x: 560, y: 330, w: 380, h: 220 },
      { label: "정문",   x: 40,  y: 540, w: 120, h: 40 }
    ]
  },

  floorSize: { width: 1000, height: 400 },

  // 건물: floors 에는 그 건물에 있는 층 번호를 적어요
  buildings: [
    { id: "B1", name: "본관",   aliases: ["본관동"],     floors: [1, 2], x: 60,  y: 60,  w: 380, h: 150 },
    { id: "B2", name: "과학관", aliases: ["실험동"],     floors: [1, 2], x: 520, y: 60,  w: 400, h: 150 },
    { id: "B3", name: "도서관", aliases: ["도서실"],     floors: [1],    x: 60,  y: 300, w: 300, h: 180 }
  ],

  // 층마다 클릭 안 되는 요소 (복도, 계단 등)
  floorDecor: [
    { building: "B1", floor: 1, label: "복도", x: 40, y: 170, w: 920, h: 60 },
    { building: "B1", floor: 2, label: "복도", x: 40, y: 170, w: 920, h: 60 },
    { building: "B2", floor: 1, label: "복도", x: 40, y: 170, w: 920, h: 60 },
    { building: "B2", floor: 2, label: "복도", x: 40, y: 170, w: 920, h: 60 },
    { building: "B3", floor: 1, label: "출입구", x: 420, y: 330, w: 160, h: 50 }
  ],

  // 공간(교실 등): id는 겹치지 않게! (건물ID-호수 추천)
  rooms: [
    // 본관 1층
    { id: "B1-101", name: "교무실",       aliases: [],             building: "B1", floor: 1, type: "사무실", x: 40,  y: 30,  w: 280, h: 140 },
    { id: "B1-102", name: "행정실",       aliases: [],             building: "B1", floor: 1, type: "사무실", x: 330, y: 30,  w: 200, h: 140 },
    { id: "B1-103", name: "보건실",       aliases: [],             building: "B1", floor: 1, type: "기타",   x: 540, y: 30,  w: 200, h: 140 },
    { id: "B1-104", name: "강당",         aliases: ["대강당"],     building: "B1", floor: 1, type: "강당",   x: 40,  y: 230, w: 500, h: 140 },
    // 본관 2층
    { id: "B1-201", name: "2-1 교실",     aliases: ["2학년 1반"],  building: "B1", floor: 2, type: "교실",   x: 40,  y: 30,  w: 220, h: 140 },
    { id: "B1-202", name: "2-2 교실",     aliases: ["2학년 2반"],  building: "B1", floor: 2, type: "교실",   x: 270, y: 30,  w: 220, h: 140 },
    { id: "B1-203", name: "수학 교사연구실", aliases: ["수학과"],  building: "B1", floor: 2, type: "교사연구실", x: 40, y: 230, w: 300, h: 140 },
    // 과학관 1층
    { id: "B2-101", name: "물리 실험실",   aliases: ["물리실", "물리실험실"], building: "B2", floor: 1, type: "실험실", x: 40,  y: 30,  w: 300, h: 140 },
    { id: "B2-102", name: "화학 실험실",   aliases: ["화학실"],    building: "B2", floor: 1, type: "실험실", x: 350, y: 30,  w: 300, h: 140 },
    { id: "B2-103", name: "준비실",        aliases: [],            building: "B2", floor: 1, type: "기타",   x: 660, y: 30,  w: 150, h: 140 },
    // 과학관 2층
    { id: "B2-201", name: "생명과학 실험실", aliases: ["생물실", "생명실"], building: "B2", floor: 2, type: "실험실", x: 40,  y: 30,  w: 300, h: 140 },
    { id: "B2-202", name: "지구과학 실험실", aliases: ["지구실"],  building: "B2", floor: 2, type: "실험실", x: 350, y: 30,  w: 300, h: 140 },
    // 도서관 1층
    { id: "B3-101", name: "열람실",        aliases: [],            building: "B3", floor: 1, type: "도서관", x: 40,  y: 30,  w: 560, h: 260 },
    { id: "B3-102", name: "세미나실",      aliases: ["스터디룸"],  building: "B3", floor: 1, type: "세미나실", x: 640, y: 30, w: 320, h: 160 }
  ]
};
