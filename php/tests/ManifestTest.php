<?php

declare(strict_types=1);

namespace Instatus\Tests;

use PHPUnit\Framework\TestCase;

/**
 * Packagist reads the composer.json at the repository root, which points
 * into php/, so it has to say what php/composer.json says.
 */
final class ManifestTest extends TestCase
{
    /**
     * @return array<string, mixed>
     */
    private static function read(string $path): array
    {
        $manifest = json_decode((string) file_get_contents($path), true, flags: JSON_THROW_ON_ERROR);
        self::assertIsArray($manifest);

        return $manifest;
    }

    public function testRootManifestMatchesThisOne(): void
    {
        $rootPath = dirname(__DIR__, 2) . '/composer.json';
        if (!is_file($rootPath)) {
            self::markTestSkipped('No root composer.json next to php/');
        }
        $root = self::read($rootPath);
        $package = self::read(dirname(__DIR__) . '/composer.json');

        foreach (['name', 'description', 'type', 'license', 'keywords', 'homepage', 'authors', 'support', 'require', 'suggest'] as $key) {
            self::assertSame($package[$key], $root[$key], "composer.json \"$key\" differs between the root and php/");
        }
        self::assertSame(['Instatus\\' => 'php/src/'], $root['autoload']['psr-4']);
        self::assertSame(['php/src/functions.php'], $root['autoload']['files']);
        self::assertSame(['Instatus\\' => 'src/'], $package['autoload']['psr-4']);
        self::assertSame(['src/functions.php'], $package['autoload']['files']);
    }
}
