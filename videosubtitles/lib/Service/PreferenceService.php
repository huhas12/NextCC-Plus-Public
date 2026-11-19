<?php
declare(strict_types=1);
// SPDX-FileCopyrightText: 2026 Dimitrios Kokkotis
// SPDX-License-Identifier: AGPL-3.0-or-later
namespace OCA\VideoSubtitles\Service;

use OCP\IConfig;

final class PreferenceService {
    public const DEFAULTS = [
        'menuLanguage' => 'auto', 'subtitleLanguages' => [], 'encoding' => 'auto',
        'webSearch' => ['custom' => [], 'selected' => ['google']],
        'backgroundEnabled' => true, 'backgroundColor' => '#000000', 'backgroundOpacity' => 0.72,
        'shadowEnabled' => true, 'shadowDepth' => 2, 'textColor' => '#ffffff', 'fontSize' => 24, 'verticalPosition' => 100, 'verticalOffset' => 0,
    ];
    public const ENCODINGS = ['auto', 'utf-8', 'windows-1253', 'utf-16le', 'utf-16be', 'windows-1252',
        'windows-1250', 'windows-1251', 'windows-1254', 'windows-1255', 'windows-1256', 'windows-1257',
        'windows-1258', 'iso-8859-7', 'iso-8859-2', 'iso-8859-15', 'shift_jis', 'euc-kr', 'gb18030', 'big5'];

    public function __construct(private IConfig $config) {
    }

    public static function normalize(array $input): array {
        $out = self::DEFAULTS;
        foreach (['menuLanguage' => ['auto', 'en', 'el'], 'encoding' => self::ENCODINGS] as $key => $allowed) {
            if (isset($input[$key]) && in_array($input[$key], $allowed, true)) $out[$key] = $input[$key];
        }
        foreach (['backgroundEnabled', 'shadowEnabled'] as $key) {
            if (isset($input[$key]) && is_bool($input[$key])) $out[$key] = $input[$key];
        }
        foreach (['backgroundColor', 'textColor'] as $key) {
            if (isset($input[$key]) && is_string($input[$key]) && preg_match('/^#[0-9a-f]{6}$/iD', $input[$key])) $out[$key] = strtolower($input[$key]);
        }
        foreach (['backgroundOpacity' => [0, 1], 'shadowDepth' => [0, 10], 'fontSize' => [14, 48], 'verticalPosition' => [0, 100], 'verticalOffset' => [-200, 200]] as $key => [$min, $max]) {
            if (isset($input[$key]) && (is_int($input[$key]) || is_float($input[$key])) && is_finite((float)$input[$key])) {
                $out[$key] = max($min, min($max, $input[$key]));
            }
        }
        if (isset($input['subtitleLanguages']) && is_array($input['subtitleLanguages'])) {
            $out['subtitleLanguages'] = array_slice(array_values(array_unique(array_filter($input['subtitleLanguages'],
                static fn ($value) => is_string($value) && (bool)preg_match('/^[a-z]{2,3}(?:-[a-z]{2,3})?$/D', $value)))), 0, 3);
        }
        if (isset($input['webSearch']) && is_array($input['webSearch'])) {
            $out['webSearch'] = self::webSearch($input['webSearch']);
        }
        return $out;
    }

    private static function webSearch(array $settings): array {
        $allowed = array_fill_keys(['google', 'bing', 'duckduckgo', 'brave', 'startpage', 'ecosia', 'qwant', 'yahoo'], true);
        $custom = [];
        foreach (is_array($settings['custom'] ?? null) ? $settings['custom'] : [] as $engine) {
            $name = is_string($engine['name'] ?? null) ? trim($engine['name']) : '';
            $url = is_string($engine['url'] ?? null) ? trim($engine['url']) : '';
            if ($name === '' || mb_strlen($name) > 80 || mb_strlen($url) > 2048 || isset($allowed[$url])
                || substr_count($url, '{query}') !== 1 || !preg_match('~^https://[^/?#{}@\\\\]+[/?#]~i', $url)) continue;
            $test = str_replace('{query}', 'test', $url);
            if (preg_match('~[\s\\\\\x00-\x1f\x7f{}]~u', $test)) continue;
            $parts = parse_url($test);
            if (empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])) continue;
            $allowed[$url] = true;
            $custom[] = ['name' => $name, 'url' => $url];
        }
        $selected = [];
        foreach (is_array($settings['selected'] ?? null) ? $settings['selected'] : ['google'] as $id) {
            if (is_string($id) && isset($allowed[$id])) $selected[$id] = true;
        }
        return ['custom' => $custom, 'selected' => array_keys($selected)];
    }

    public function get(string $uid): array {
        $data = json_decode($this->config->getUserValue($uid, 'videosubtitles', 'preferences', '{}'), true);
        return self::normalize(is_array($data) ? $data : []);
    }

    public function save(string $uid, array $preferences): array {
        if (!array_key_exists('webSearch', $preferences)) {
            $preferences['webSearch'] = $this->get($uid)['webSearch'];
        }
        $clean = self::normalize($preferences);
        $this->config->setUserValue($uid, 'videosubtitles', 'preferences', json_encode($clean, JSON_THROW_ON_ERROR));
        return $clean;
    }
}
