<?php

declare(strict_types=1);

namespace Instatus\Tests;

use Instatus\Event;
use Instatus\Scope;
use Instatus\Sdk;
use PHPUnit\Framework\TestCase;

use function Instatus\setTag;
use function Instatus\withScope;

final class ScopeTest extends TestCase
{
    protected function tearDown(): void
    {
        Sdk::reset();
    }

    public function testEventValuesWinOverTheScope(): void
    {
        $scope = (new Scope())
            ->setUser(['id' => 'scope-user'])
            ->setTags(['plan' => 'free', 'region' => 'eu'])
            ->setExtra('retry', 1)
            ->setContext('cart', ['items' => 1]);
        $event = Event::fromMessage('hi', 'info');
        $event->tags = ['plan' => 'pro'];

        $applied = $scope->applyTo($event);

        self::assertSame(['plan' => 'pro', 'region' => 'eu'], $applied->tags);
        self::assertSame(['id' => 'scope-user'], $applied->user);
        self::assertSame(['retry' => 1], $applied->extra);
        self::assertSame(['cart' => ['items' => 1]], $applied->contexts);
        self::assertSame([], $event->extra, 'the original event is left alone');
    }

    public function testScopeLevelOverridesTheEventLevel(): void
    {
        $applied = (new Scope())->setLevel('fatal')->applyTo(Event::fromMessage('hi', 'info'));

        self::assertSame('fatal', $applied->level);
    }

    public function testUpdateTakesACaptureContext(): void
    {
        $scope = (new Scope())->update([
            'user' => ['email' => 'ada@example.com'],
            'level' => 'warning',
            'tags' => ['step' => 'charge'],
            'extra' => ['attempt' => 2],
            'contexts' => ['order' => ['id' => 7]],
        ]);
        $applied = $scope->applyTo(Event::fromMessage('hi', 'info'));

        self::assertSame('warning', $applied->level);
        self::assertSame(['email' => 'ada@example.com'], $applied->user);
        self::assertSame(['step' => 'charge'], $applied->tags);
        self::assertSame(['attempt' => 2], $applied->extra);
        self::assertSame(['order' => ['id' => 7]], $applied->contexts);
    }

    public function testSetContextNullRemovesIt(): void
    {
        $scope = (new Scope())->setContext('cart', ['items' => 1])->setContext('cart', null);

        self::assertSame([], $scope->applyTo(Event::fromMessage('hi', 'info'))->contexts);
    }

    public function testWithScopeChangesStayInside(): void
    {
        setTag('plan', 'pro');

        $inner = withScope(static function (Scope $scope): array {
            $scope->setTag('job', 'invoice');
            setTag('step', 'render');

            return Sdk::currentScope()->applyTo(Event::fromMessage('hi', 'info'))->tags;
        });
        $outer = Sdk::currentScope()->applyTo(Event::fromMessage('hi', 'info'))->tags;

        self::assertSame(['plan' => 'pro', 'job' => 'invoice', 'step' => 'render'], $inner);
        self::assertSame(['plan' => 'pro'], $outer);
    }

    public function testWithScopeNests(): void
    {
        $tags = withScope(static fn (Scope $outer): array => withScope(static function (Scope $inner) use ($outer): array {
            $outer->setTag('outer', '1');
            $inner->setTag('inner', '1');

            return Sdk::currentScope()->applyTo(Event::fromMessage('hi', 'info'))->tags;
        }));

        self::assertSame(['inner' => '1'], $tags, 'the inner scope is a copy taken before the outer changed');
        self::assertSame([], Sdk::currentScope()->applyTo(Event::fromMessage('hi', 'info'))->tags);
    }
}
