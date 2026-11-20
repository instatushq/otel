<?php

declare(strict_types=1);

require $argv[1];

\Instatus\init(['api_key' => 'sk_test', 'site_id' => 'site_1', 'endpoint' => $argv[2]]);

throw new RuntimeException('Unhandled checkout failure');
