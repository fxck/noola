defmodule NoolaEdge.MixProject do
  use Mix.Project

  def project do
    [
      app: :noola_edge,
      version: "0.1.0",
      elixir: "~> 1.16",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      releases: releases()
    ]
  end

  # Configuration for the OTP application.
  def application do
    [
      mod: {NoolaEdge.Application, []},
      # :inets/:ssl power :httpc for the api /auth/me token check.
      extra_applications: [:logger, :runtime_tools, :inets, :ssl]
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      {:phoenix, "~> 1.7.14"},
      {:phoenix_pubsub, "~> 2.1"},
      {:jason, "~> 1.4"},
      {:bandit, "~> 1.5"},
      {:gnat, "~> 1.9"},
      {:y_ex, "~> 0.10"}
    ]
  end

  defp releases do
    [
      noola_edge: [
        include_executables_for: [:unix]
      ]
    ]
  end
end
