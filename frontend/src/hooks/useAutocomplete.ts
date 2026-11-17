"use client";

import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "./useDebouncedValue";
import { FuzzySearcher, type SearchableItem, type SearchResult } from "@/lib/fuzzySearch";
import { apiGet } from "@/lib/api";

/** An address seen in the user's mail, as returned by /api/addresses/autocomplete. */
export interface AutocompleteSuggestion {
  email: string;
  name: string;
  source?: "known";
}

export interface AutocompleteResult extends SearchResult {
  item: SearchableItem;
}

interface AutocompleteApiResponse {
  suggestions: AutocompleteSuggestion[];
}

const MIN_QUERY_LENGTH = 2;

export function useAutocomplete(
  query: string,
  debounceMs: number = 200
): {
  results: AutocompleteResult[];
  isLoading: boolean;
  error: Error | null;
} {
  const debouncedQuery = useDebouncedValue(query, debounceMs);

  const { data: allAddresses, isLoading: isLoadingAll } = useQuery<AutocompleteApiResponse>({
    queryKey: ["address-autocomplete-all"],
    queryFn: () => apiGet<AutocompleteApiResponse>("/addresses/autocomplete/all"),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  const { data: serverResults, isLoading: isLoadingServer, error } = useQuery<AutocompleteApiResponse>({
    queryKey: ["address-autocomplete", debouncedQuery],
    queryFn: () =>
      apiGet<AutocompleteApiResponse>(
        `/addresses/autocomplete?q=${encodeURIComponent(debouncedQuery)}&limit=20`
      ),
    enabled: debouncedQuery.length >= MIN_QUERY_LENGTH && !allAddresses?.suggestions?.length,
    staleTime: 30000,
  });

  const results = (() => {
    if (debouncedQuery.length < MIN_QUERY_LENGTH) {
      return [];
    }

    const suggestions = allAddresses?.suggestions?.length
      ? allAddresses.suggestions
      : serverResults?.suggestions;

    if (suggestions) {
      const searchableItems: SearchableItem[] = suggestions.map((s) => ({
        email: s.email,
        name: s.name,
        source: "known",
      }));

      const searcher = new FuzzySearcher();
      searcher.setItems(searchableItems);
      return searcher.search(debouncedQuery, 20) as AutocompleteResult[];
    }

    return [];
  })();

  return {
    results,
    isLoading: isLoadingAll || isLoadingServer,
    error: error,
  };
}

export type { SearchableItem, SearchResult };
