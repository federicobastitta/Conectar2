import { useEffect } from "react";
import { useLocation } from "wouter";
import { useGetMe, useLogout } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export function useAuth() {
  const [location, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { data: user, isLoading, error } = useGetMe({ 
    query: { 
      retry: false 
    } 
  });
  
  const logout = useLogout();

  useEffect(() => {
    // Basic protection logic
    const publicPaths = ["/login", "/reservar", "/mi-turno"];
    const isPublic = publicPaths.some(p => location.startsWith(p));
    
    if (!isLoading && error && !isPublic) {
      setLocation("/login");
    }
  }, [user, isLoading, error, location, setLocation]);

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        localStorage.removeItem("auth_token");
        queryClient.clear();
        setLocation("/login");
      }
    });
  };

  return { user, isLoading, logout: handleLogout };
}
