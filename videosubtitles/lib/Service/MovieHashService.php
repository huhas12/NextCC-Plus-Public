<?php
declare(strict_types=1);
// SPDX-License-Identifier: AGPL-3.0-or-later
namespace OCA\VideoSubtitles\Service;

use OCP\Files\File;
use OCP\Files\IRootFolder;

final class MovieHashService {
    public const CHUNK = 65536;

    public function __construct(private IRootFolder $root) {
    }

    /** Sum the size and two 64 KiB chunks as little-endian uint64, modulo 2^64. */
    public static function fromChunks(string $first, string $last, int $size): string {
        if (PHP_INT_SIZE < 8 || $size < self::CHUNK * 2 || strlen($first) !== self::CHUNK || strlen($last) !== self::CHUNK) {
            throw new ApiException('hash_unavailable');
        }
        $low = $size & 0xffffffff;
        $high = ($size >> 32) & 0xffffffff;
        foreach ([$first, $last] as $chunk) {
            for ($at = 0; $at < self::CHUNK; $at += 8) {
                $word = unpack('Vlow/Vhigh', $chunk, $at);
                $sum = $low + $word['low'];
                $high = ($high + $word['high'] + ($sum >> 32)) & 0xffffffff;
                $low = $sum & 0xffffffff;
            }
        }
        return sprintf('%08x%08x', $high, $low);
    }

    public function calculate(string $uid, string $path): array {
        if ($path === '' || strlen($path) > 4096 || $path[0] !== '/' || str_contains($path, "\0")
            || str_contains($path, '\\') || preg_match('~(?:^|/)\.\.(?:/|$)~', $path)) throw new ApiException('invalid_video_path');
        try { $file = $this->root->getUserFolder($uid)->get($path); }
        catch (\Throwable) { throw new ApiException('video_not_found', 404); }
        if (!$file instanceof File || !$file->isReadable()
            || (!str_starts_with($file->getMimetype(), 'video/') && !preg_match('/\.(mp4|mkv|webm|mov|m4v|ogv|avi|mpeg|mpg|m2ts|ts)$/iD', $file->getName()))) {
            throw new ApiException('video_not_found', 404);
        }
        $size = $file->getSize();
        if (!is_int($size) || $size < self::CHUNK * 2) throw new ApiException('hash_unavailable');
        $etag = $file->getEtag();
        $stream = null;
        try {
            $stream = $file->fopen('rb');
            if (!is_resource($stream) || !stream_get_meta_data($stream)['seekable']) throw new ApiException('hash_unavailable');
            $first = stream_get_contents($stream, self::CHUNK);
            if (fseek($stream, $size - self::CHUNK) !== 0) throw new ApiException('hash_unavailable');
            $last = stream_get_contents($stream, self::CHUNK);
            if ($first === false || $last === false || $file->getEtag() !== $etag) throw new ApiException('hash_unavailable');
            return ['hash' => self::fromChunks($first, $last, $size), 'size' => $size];
        } catch (ApiException $e) { throw $e; }
        catch (\Throwable) { throw new ApiException('hash_unavailable'); }
        finally { if (is_resource($stream)) fclose($stream); }
    }
}
