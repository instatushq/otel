<?php

declare(strict_types=1);

namespace Instatus;

final class Scope
{
    /** @var array<string, mixed>|null */
    private ?array $user = null;
    private ?string $level = null;
    /** @var array<string, scalar|null> */
    private array $tags = [];
    /** @var array<string, mixed> */
    private array $extra = [];
    /** @var array<string, mixed> */
    private array $contexts = [];

    /**
     * @param array<string, mixed>|null $user
     */
    public function setUser(?array $user): self
    {
        $this->user = $user;

        return $this;
    }

    /**
     * @return array<string, mixed>|null
     */
    public function getUser(): ?array
    {
        return $this->user;
    }

    public function setTag(string $key, string|int|float|bool|null $value): self
    {
        $this->tags[$key] = $value;

        return $this;
    }

    /**
     * @param array<string, scalar|null> $tags
     */
    public function setTags(array $tags): self
    {
        foreach ($tags as $key => $value) {
            $this->setTag((string) $key, $value);
        }

        return $this;
    }

    public function setExtra(string $key, mixed $value): self
    {
        $this->extra[$key] = $value;

        return $this;
    }

    /**
     * @param array<string, mixed> $extras
     */
    public function setExtras(array $extras): self
    {
        foreach ($extras as $key => $value) {
            $this->setExtra((string) $key, $value);
        }

        return $this;
    }

    /**
     * @param array<string, mixed>|null $context
     */
    public function setContext(string $name, ?array $context): self
    {
        if ($context === null) {
            unset($this->contexts[$name]);
        } else {
            $this->contexts[$name] = $context;
        }

        return $this;
    }

    public function setLevel(?string $level): self
    {
        $this->level = $level;

        return $this;
    }

    /**
     * Takes Sentry's capture context: user, level, tags, extra and contexts.
     *
     * @param array{user?: array<string, mixed>|null, level?: string, tags?: array<string, scalar|null>, extra?: array<string, mixed>, contexts?: array<string, array<string, mixed>|null>} $context
     */
    public function update(array $context): self
    {
        if (isset($context['user'])) {
            $this->setUser($context['user']);
        }
        if (isset($context['level'])) {
            $this->setLevel($context['level']);
        }
        $this->setTags($context['tags'] ?? []);
        $this->setExtras($context['extra'] ?? []);
        foreach ($context['contexts'] ?? [] as $name => $value) {
            $this->setContext((string) $name, $value);
        }

        return $this;
    }

    public function clear(): self
    {
        $this->user = null;
        $this->level = null;
        $this->tags = [];
        $this->extra = [];
        $this->contexts = [];

        return $this;
    }

    /**
     * Event values win over the scope's, as in Sentry: captureException with
     * tags beats setTag.
     */
    public function applyTo(Event $event): Event
    {
        $applied = clone $event;
        $applied->level = $this->level ?? $event->level;
        $applied->user = $event->user ?? $this->user;
        $applied->tags = array_merge($this->tags, $event->tags);
        $applied->extra = array_merge($this->extra, $event->extra);
        $applied->contexts = array_merge($this->contexts, $event->contexts);

        return $applied;
    }
}
