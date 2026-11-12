<?php
declare(strict_types=1);

return ['routes' => [
    ['name' => 'api#settings', 'url' => '/api/settings', 'verb' => 'GET'],
    ['name' => 'api#preferences', 'url' => '/api/preferences', 'verb' => 'PUT'],
    ['name' => 'api#configurePublicLinks', 'url' => '/api/public-links', 'verb' => 'PUT'],
    ['name' => 'api#connect', 'url' => '/api/opensubtitles/connect', 'verb' => 'POST'],
    ['name' => 'api#configureApplication', 'url' => '/api/opensubtitles/application', 'verb' => 'PUT'],
    ['name' => 'api#disconnect', 'url' => '/api/opensubtitles/disconnect', 'verb' => 'POST'],
    ['name' => 'api#languages', 'url' => '/api/opensubtitles/languages', 'verb' => 'GET'],
    ['name' => 'api#search', 'url' => '/api/opensubtitles/search', 'verb' => 'POST'],
    ['name' => 'api#download', 'url' => '/api/opensubtitles/download', 'verb' => 'POST'],
]];
