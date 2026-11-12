<?php
declare(strict_types=1);
// SPDX-License-Identifier: AGPL-3.0-or-later
namespace OCA\VideoSubtitles\Service;

final class ApiException extends \RuntimeException {
    public function __construct(public readonly string $reason, public readonly int $status = 400) {
        parent::__construct($reason);
    }
}
