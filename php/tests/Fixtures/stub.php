<?php

declare(strict_types=1);

$delay = (float) getenv('STUB_DELAY');
if ($delay > 0) {
    usleep((int) ($delay * 1e6));
}
$body = (string) file_get_contents('php://input');
if (($_SERVER['HTTP_CONTENT_ENCODING'] ?? '') === 'gzip') {
    $body = (string) gzdecode($body);
}
$request = [
    'path' => parse_url((string) $_SERVER['REQUEST_URI'], PHP_URL_PATH),
    'headers' => array_change_key_case(getallheaders(), CASE_LOWER),
    'body' => base64_encode($body),
];
file_put_contents(
    getenv('STUB_DIR') . '/' . hrtime(true) . '.json',
    json_encode($request, JSON_THROW_ON_ERROR)
);
header('Content-Type: application/x-protobuf');
