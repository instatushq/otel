<?php

declare(strict_types=1);

require $argv[1];

\Instatus\init(['api_key' => 'sk_test', 'site_id' => 'site_1', 'endpoint' => $argv[2]]);

ini_set('memory_limit', '64M');
$chunks = [];
while (true) {
    $chunks[] = str_repeat('x', 1024 * 1024);
}
