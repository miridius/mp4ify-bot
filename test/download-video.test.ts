import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
  spyOn,
} from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import {
  downloadVideo,
  getInfo,
  sendInfo,
  sendVideo,
} from '../src/download-video';
import { spyMock } from './test-utils';

beforeEach(() => jest.clearAllMocks());
afterAll(() => mock.restore());

// Mocks
const mockAppend = mock();
const appendedText = () => mockAppend.mock.calls.map(([s]) => s).join('\n');
const mockFlush = mock();
const log = { append: mockAppend, flush: mockFlush };

const mockWrite = spyMock(Bun, 'write');

const mockSendVideo = mock();
const mockJson = mock();
const mockText = mock();
const mockExists = mock();
const mockFile = spyOn(Bun, 'file').mockImplementation(
  () =>
    ({
      exists: mockExists,
      text: mockText,
      json: mockJson,
      name: '/mocked/file',
    }) as any,
);

const VideoInfo = {
  filename: 'file.mp4',
  title: 'Test',
  webpage_url: 'url',
  duration: 10,
  width: 100,
  height: 100,
};

const mockSpawnImpl =
  (stdout?: string, stderr?: string, overrides?: any) => () => ({
    stdout: new ReadableStream({
      start(controller) {
        stdout && controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        stderr && controller.enqueue(new TextEncoder().encode(stderr));
        controller.close();
      },
    }),
    exitCode: 0,
    exited: Promise.resolve(),
    ...overrides,
  });

const mockSpawn = spyOn(Bun, 'spawn').mockImplementation(() => {
  throw new Error('unexpected call to spawn');
});

const telegram = {
  sendVideo: mockSendVideo.mockResolvedValue({ video: { file_id: 'id' } }),
};
const ctx = { me: 'bot', telegram };

// Mock modules
const mockStat = spyOn(fsPromises, 'stat').mockResolvedValue({
  size: 1000,
} as any);
const mockUnlink = spyMock(fsPromises, 'unlink');
spyMock(fsPromises, 'symlink');
spyMock(fsPromises, 'mkdir');

describe('getInfo', () => {
  beforeEach(() => getInfo.cache.clear());

  it('returns cached info if file exists', async () => {
    mockExists.mockResolvedValueOnce(true);
    mockJson.mockResolvedValueOnce({ filename: 'cached.mp4' });

    const info = await getInfo(log as any, 'url');

    expect(mockExists).toHaveBeenCalledTimes(1);
    expect(info.filename).toBe('cached.mp4');
    expect(mockFile.mock.calls[0]).toMatchInlineSnapshot(`
      [
        "/storage/_video-info/KOXrq9nY9uI332PaK1A3hQk_AikkG8cCEZj2PEO5Mmk",
      ]
    `);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('fetches info if not cached', async () => {
    mockExists.mockResolvedValueOnce(false);
    mockSpawn.mockImplementationOnce(mockSpawnImpl(JSON.stringify(VideoInfo)));

    const info = await getInfo(log as any, 'url');

    expect(mockExists).toHaveBeenCalled();
    expect(appendedText()).toMatchInlineSnapshot(`"🧐 <b>Scraping</b> url..."`);
    expect(mockSpawn.mock.calls[0]).toMatchInlineSnapshot(`
      [
        [
          "yt-dlp",
          "url",
          "--no-warnings",
          "--dump-json",
        ],
        {
          "stderr": "pipe",
          "timeout": 300000,
        },
      ]
    `);
    expect(mockWrite.mock.calls[0]).toMatchInlineSnapshot(`
      [
        {
          "exists": [class Function],
          "json": [class Function],
          "name": "/mocked/file",
          "text": [class Function],
        },
        "{"filename":"file.mp4","title":"Test","webpage_url":"url","duration":10,"width":100,"height":100}",
      ]
    `);
    expect(info.filename).toBe(VideoInfo.filename);
  });

  it('handles canonical urls', async () => {
    // Simulate info.webpage_url !== url
    mockExists.mockResolvedValueOnce(false);
    const infoWithCanonical = { ...VideoInfo, webpage_url: 'canonical-url' };
    mockSpawn.mockImplementationOnce(
      mockSpawnImpl(JSON.stringify(infoWithCanonical)),
    );
    const info = await getInfo(log as any, 'not-canonical-url');
    expect(info.webpage_url).toBe('canonical-url');
    expect(mockWrite.mock.calls).toMatchInlineSnapshot(`
    [
      [
        {
          "exists": [class Function],
          "json": [class Function],
          "name": "/mocked/file",
          "text": [class Function],
        },
        "{"filename":"file.mp4","title":"Test","webpage_url":"canonical-url","duration":10,"width":100,"height":100}",
      ],
    ]
  `);
  });
});

describe('sendInfo', () => {
  it('logs video info', async () => {
    await sendInfo(log as any, VideoInfo);
    expect(appendedText()).toMatchInlineSnapshot(`
      "
      🎬 <b>Video info:</b>

      <b>URL</b>: url
      <b>filename</b>: file.mp4
      <b>duration</b>: 10 sec
      <b>resolution</b>: 100x100"
    `);
  });

  it('logs formats', async () => {
    // Provide formats array to logFormats
    const infoWithFormats = {
      ...VideoInfo,
      formats: [
        {
          format: 'best',
          ext: 'mp4',
          vcodec: 'h264',
          acodec: 'aac',
          tbr: 1000,
          filesize: 10485760,
        },
      ],
    };
    const consoleTable = spyOn(console, 'table').mockImplementation(mock());
    await sendInfo(log as any, infoWithFormats);
    expect(consoleTable).toHaveBeenCalled();
  });

  it.each([
    { resolution: '1920x1080', expected: '1920x1080' },
    { height: 1080, width: 0, expected: '1080p' },
    { height: 0, width: 0, format_id: 'hd', expected: 'HD' },
  ])('parses %o', async ({ expected, ...overrides }) => {
    // Test parseRes via sendInfo
    const info = { ...VideoInfo, ...overrides };
    await sendInfo(log as any, info);
    expect(appendedText()).toInclude(`<b>resolution</b>: ${expected}`);
  });

  it('calculates duration without sponsors', async () => {
    // Test sponsorblock_chapters are subtracted from duration
    const infoWithSponsors = {
      ...VideoInfo,
      duration: 100,
      sponsorblock_chapters: [
        {
          start_time: 10,
          end_time: 20,
          category: 'sponsor',
          title: 'Sponsor',
          type: 'skip',
        },
        {
          start_time: 30,
          end_time: 40,
          category: 'sponsor',
          title: 'Sponsor',
          type: 'skip',
        },
      ],
    };
    await sendInfo(log as any, infoWithSponsors);
    // Duration should be 80 (100 - (10+10))
    expect(appendedText()).toMatchInlineSnapshot(`
      "
      🎬 <b>Video info:</b>
  
      <b>URL</b>: url
      <b>filename</b>: file.mp4
      <b>duration</b>: 80 sec (100s before removing sponsors)
      <b>resolution</b>: 100x100"
    `);
  });
});

describe('downloadVideo', () => {
  beforeEach(() => downloadVideo.cache.clear());

  it("returns 'already downloaded' if id file exists", async () => {
    mockExists.mockResolvedValueOnce(true);
    const result = await downloadVideo(ctx as any, log as any, VideoInfo);
    expect(mockFile.mock.calls[0]).toMatchInlineSnapshot(`
      [
        "file.mp4.bot.id",
      ]
    `);
    expect(result).toBe('already downloaded');
  });

  it("returns 'already downloaded' if video file exists", async () => {
    mockExists.mockResolvedValueOnce(false);
    mockExists.mockResolvedValueOnce(true);
    const result = await downloadVideo(ctx as any, log as any, VideoInfo);
    expect(mockFile.mock.calls[1]).toMatchInlineSnapshot(`
      [
        "file.mp4",
      ]
    `);
    expect(result).toBe('already downloaded');
  });

  it('calls yt-dlp if not downloaded', async () => {
    mockExists.mockResolvedValue(false);
    mockSpawn.mockImplementationOnce(mockSpawnImpl('some output'));

    const result = await downloadVideo(ctx as any, log as any, VideoInfo);

    expect(appendedText()).toMatchInlineSnapshot(`
      "
      ⬇️ <b>Downloading...</b>"
    `);
    expect(mockSpawn.mock.calls[0]).toMatchInlineSnapshot(`
      [
        [
          "yt-dlp",
          "",
          "--no-warnings",
          "--load-info-json",
          "/mocked/file",
        ],
        {
          "stderr": "pipe",
          "timeout": 300000,
        },
      ]
    `);
    expect(result).toBe('some output');
  });

  it('logs stderr', async () => {
    mockExists.mockResolvedValue(false);
    mockSpawn.mockImplementationOnce(mockSpawnImpl('', 'foo\nbar\n'));
    await downloadVideo(ctx as any, log as any, VideoInfo);
    expect(appendedText()).toMatchInlineSnapshot(`
      "
      ⬇️ <b>Downloading...</b>
  
      <code>foo
      bar</code>"
    `);
  });

  describe('error messages for failures', () => {
    it.each([
      ['SIGTERM', 1, 'Timed out after 300 seconds'],
      ['FOO', 1, 'yt-dlp was killed with signal FOO'],
      [undefined, 123, 'yt-dlp exited with code 123'],
    ])('signalCode: %p', async (signalCode, exitCode, message) => {
      expect.assertions(1);
      mockExists.mockResolvedValue(false);

      mockSpawn.mockImplementationOnce(
        mockSpawnImpl('', '', { signalCode, exitCode }),
      );
      expect(downloadVideo(ctx as any, log as any, VideoInfo)).rejects.toThrow(
        message,
      );
    });
  });
});

describe('sendVideo', () => {
  beforeEach(() => sendVideo.cache.clear());

  it('uploads video if no fileId', async () => {
    mockExists.mockResolvedValueOnce(false); // id file
    mockExists.mockResolvedValueOnce(true); // video file
    const res = await sendVideo(ctx as any, log as any, VideoInfo, 123);
    expect(mockSendVideo.mock.calls[0]).toMatchInlineSnapshot(`
      [
        123,
        "file:///app/file.mp4",
        {
          "disable_notification": true,
          "duration": 10,
          "height": 100,
          "supports_streaming": true,
          "width": 100,
        },
      ]
    `);
    expect(mockUnlink.mock.calls[0]).toMatchInlineSnapshot(`
      [
        "file.mp4",
      ]
    `);
    expect(res?.video.file_id).toBe('id');
  });

  it('returns undefined if video too large', async () => {
    mockExists.mockResolvedValueOnce(false); // id file
    mockExists.mockResolvedValueOnce(true); // video file
    mockStat.mockResolvedValueOnce({ size: 3000 * 1024 * 1024 } as any); // too big
    const res = await sendVideo(ctx as any, log as any, VideoInfo, 123);
    expect(res).toBeUndefined();
    expect(mockAppend).toHaveBeenCalledWith(
      expect.stringContaining('too large'),
    );
  });

  it('throws if video file not found', async () => {
    expect.assertions(1);
    mockExists.mockResolvedValueOnce(false); // id file
    mockExists.mockResolvedValueOnce(false); // video file
    await expect(
      sendVideo(ctx as any, log as any, VideoInfo, 123),
    ).rejects.toThrow('yt-dlp output file not found');
  });

  it('sends the video as a reply message if requested', async () => {
    // sendVideo with replyToMessageId
    mockExists.mockResolvedValueOnce(false); // id file
    mockExists.mockResolvedValueOnce(true); // video file
    const replyToMessageId = 456;
    await sendVideo(ctx as any, log as any, VideoInfo, 123, replyToMessageId);
    expect(mockSendVideo.mock.calls[0]?.[2]).toMatchObject({
      reply_to_message_id: replyToMessageId,
    });
  });
});
