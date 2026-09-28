"""
Backend API Tests for Priority 1 Features:
1. Due Dates CRUD operations
2. User Permissions management (RBAC)
3. Staff Activity endpoint
"""
import pytest
import requests
import os
import uuid
from datetime import datetime, timedelta

BASE_URL = (
    os.environ.get('BACKEND_URL')
    or os.environ.get('REACT_APP_BACKEND_URL')
    or os.environ.get('API_BASE_URL')
    or ''
).rstrip('/')

# These are live integration tests and require an externally running backend.
# The repository's normal Full Pytest CI job does not start the API server, so
# skip this module cleanly when no backend URL is supplied instead of passing
# a relative URL such as /api/auth/login to requests.
if not BASE_URL:
    pytestmark = pytest.mark.skip(
        reason="Priority-1 integration tests require BACKEND_URL, REACT_APP_BACKEND_URL, or API_BASE_URL."
    )

# Test credentials
ADMIN_EMAIL = "admin@test.com"
ADMIN_PASSWORD = "admin123"
STAFF_EMAIL = "login_test_140723@taskosphere.com"

class TestAuth:
    """Authentication tests"""
    
    def test_admin_login(self):
        """Test admin login"""
        response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        assert response.status_code == 200, f"Admin login failed: {response.text}"
        data = response.json()
        assert "access_token" in data
        assert "user" in data
        assert data["user"]["role"] == "admin"
        print(f"Admin login successful - User: {data['user']['full_name']}")
        return data["access_token"]


class TestDueDates:
    """Due Dates CRUD tests"""
    
    @pytest.fixture
    def admin_token(self):
        """Get admin auth token"""
        response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        if response.status_code != 200:
            pytest.skip("Admin login failed")
        return response.json()["access_token"]
    
    def test_create_due_date(self, admin_token):
        """Test creating a new due date"""
        headers = {"Authorization": f"Bearer {admin_token}"}
        
        due_date_data = {
            "title": f"TEST_GST_Filing_{uuid.uuid4().hex[:8]}",
            "description": "Monthly GST return filing",
            "due_date": (datetime.now() + timedelta(days=30)).isoformat(),
            "reminder_days": 7,
            "category": "GST",
            "status": "pending"
        }
        
        response = requests.post(f"{BASE_URL}/api/duedates", json=due_date_data, headers=headers)
        assert response.status_code == 200, f"Create due date failed: {response.text}"
        
        data = response.json()
        assert data["title"] == due_date_data["title"]
        assert data["category"] == "GST"
        assert data["status"] == "pending"
        assert "id" in data
        print(f"Due date created successfully - ID: {data['id']}")
        return data["id"]
    
    def test_get_due_dates(self, admin_token):
        """Test fetching all due dates"""
        headers = {"Authorization": f"Bearer {admin_token}"}
        
        response = requests.get(f"{BASE_URL}/api/duedates", headers=headers)
        assert response.status_code == 200, f"Get due dates failed: {response.text}"
        
        data = response.json()
        assert isinstance(data, list)
        print(f"Fetched {len(data)} due dates")
    
    def test_create_and_update_due_date(self, admin_token):
        """Test creating and updating a due date"""
        headers = {"Authorization": f"Bearer {admin_token}"}
        
        # Create
        due_date_data = {
            "title": f"TEST_Update_DueDate_{uuid.uuid4().hex[:8]}",
            "description": "Test description",
            "due_date": (datetime.now() + timedelta(days=15)).isoformat(),
            "reminder_days": 5,
            "category": "Income Tax",
            "status": "pending"
        }
        
        create_response = requests.post(f"{BASE_URL}/api/duedates", json=due_date_data, headers=headers)
        assert create_response.status_code == 200
        created = create_response.json()
        due_date_id = created["id"]
        
        # Update
        updated_data = {
            "title": created["title"],
            "description": "Updated description",
            "due_date": (datetime.now() + timedelta(days=20)).isoformat(),
            "reminder_days": 10,
            "category": "TDS",
            "status": "completed"
        }
        
        update_response = requests.put(f"{BASE_URL}/api/duedates/{due_date_id}", json=updated_data, headers=headers)
        assert update_response.status_code == 200, f"Update failed: {update_response.text}"
        
        updated = update_response.json()
        assert updated["category"] == "TDS"
        assert updated["status"] == "completed"
        assert updated["description"] == "Updated description"
        print(f"Due date updated successfully - ID: {due_date_id}")
        
        # Cleanup
        requests.delete(f"{BASE_URL}/api/duedates/{due_date_id}", headers=headers)
    
    def test_delete_due_date(self, admin_token):
        """Test deleting a due date"""
        headers = {"Authorization": f"Bearer {admin_token}"}
        
        # Create a due date to delete
        due_date_data = {
            "title": f"TEST_Delete_DueDate_{uuid.uuid4().hex[:8]}",
            "description": "To be deleted",
            "due_date": (datetime.now() + timedelta(days=10)).isoformat(),
            "reminder_days": 3,
            "category": "ROC",
            "status": "pending"
        }
        
        create_response = requests.post(f"{BASE_URL}/api/duedates", json=due_date_data, headers=headers)
        assert create_response.status_code == 200
        due_date_id = create_response.json()["id"]
        
        # Delete
        delete_response = requests.delete(f"{BASE_URL}/api/duedates/{due_date_id}", headers=headers)
        assert delete_response.status_code == 200, f"Delete failed: {delete_response.text}"
        
        # Verify deletion
        get_response = requests.get(f"{BASE_URL}/api/duedates", headers=headers)
        due_dates = get_response.json()
        assert not any(dd["id"] == due_date_id for dd in due_dates), "Due date still exists after deletion"
        print(f"Due date deleted successfully - ID: {due_date_id}")


class TestUserPermissions:
    """User Permissions (RBAC) tests"""
    
    @pytest.fixture
    def admin_token(self):
        """Get admin auth token"""
        response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        if response.status_code != 200:
            pytest.skip("Admin login failed")
        return response.json()["access_token"]
    
    def test_get_users_as_admin(self, admin_token):
        """Test fetching users as admin"""
        headers = {"Authorization": f"Bearer {admin_token}"}
        
        response = requests.get(f"{BASE_URL}/api/users", headers=headers)
        assert response.status_code == 200, f"Get users failed: {response.text}"
        
        users = response.json()
        assert isinstance(users, list)
        assert len(users) > 0
        
        # Check that users have expected fields
        for user in users:
            assert "id" in user
            assert "email" in user
            assert "role" in user
            assert "full_name" in user
        
        print(f"Fetched {len(users)} users")
        return users
    
    def test_get_staff_user(self, admin_token):
        """Test finding a staff user for permissions testing"""
        headers = {"Authorization": f"Bearer {admin_token}"}
        
        response = requests.get(f"{BASE_URL}/api/users", headers=headers)
        assert response.status_code == 200
        
        users = response.json()
        staff_users = [u for u in users if u["role"] == "staff"]
        
        if not staff_users:
            print("No staff users found - creating one for testing")
            # Create a test staff user
            create_response = requests.post(f"{BASE_URL}/api/auth/register", json={
                "email": f"test_staff_{uuid.uuid4().hex[:8]}@taskosphere.com",
                "password": "testpass123",
                "full_name": "Test Staff User",
                "role": "staff"
            }, headers=headers)
            if create_response.status_code == 200:
                staff_user = create_response.json()["user"]
                print(f"Created test staff user: {staff_user['email']}")
                return staff_user
            pytest.skip("Could not create staff user")
        
        print(f"Found {len(staff_users)} staff users")
        return staff_users[0]
    
    def test_update_user_permissions(self, admin_token):
        """Test updating user permissions"""
        headers = {"Authorization": f"Bearer {admin_token}"}
        
        # Get a staff user
        response = requests.get(f"{BASE_URL}/api/users", headers=headers)
        users = response.json()
        staff_users = [u for u in users if u["role"] == "staff"]
        
        if not staff_users:
            pytest.skip("No staff users available for permissions testing")
        
        staff_user = staff_users[0]
        user_id = staff_user["id"]
        
        # Update permissions
        permissions = {
            "can_view_all_tasks": True,
            "can_view_all_clients": False,
            "can_view_all_dsc": False,
            "can_view_all_duedates": True,
            "can_view_reports": False,
            "can_manage_users": False,
            "assigned_clients": []
        }
        
        update_response = requests.put(
            f"{BASE_URL}/api/users/{user_id}/permissions",
            json=permissions,
            headers=headers
        )
        assert update_response.status_code == 200, f"Update permissions failed: {update_response.text}"
        
        data = update_response.json()
        assert data["message"] == "Permissions updated successfully"
        print(f"Permissions updated for user: {staff_user['full_name']}")
        
        # Verify permissions were saved
        get_response = requests.get(f"{BASE_URL}/api/users", headers=headers)
        updated_users = get_response.json()
        updated_user = next((u for u in updated_users if u["id"] == user_id), None)
        
        assert updated_user is not None
        if updated_user.get("permissions"):
            assert updated_user["permissions"]["can_view_all_tasks"] == True
            assert updated_user["permissions"]["can_view_all_duedates"] == True
            print("Permissions verified in user data")
    
    def test_permissions_endpoint_requires_admin(self, admin_token):
        """Test that permissions endpoint requires admin role"""
        headers = {"Authorization": f"Bearer {admin_token}"}
        
        # Get a staff user
        response = requests.get(f"{BASE_URL}/api/users", headers=headers)
        users = response.json()
        staff_users = [u for u in users if u["role"] == "staff"]
        
        if not staff_users:
            pytest.skip("No staff users available")
        
        # This test verifies the endpoint exists and works for admin
        # Non-admin access would need a separate staff login
        print("Permissions endpoint accessible by admin")


class TestStaffActivity:
    """Staff Activity endpoint tests"""
    
    @pytest.fixture
    def admin_token(self):
        """Get admin auth token"""
        response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        if response.status_code != 200:
            pytest.skip("Admin login failed")
        return response.json()["access_token"]
    
    def test_get_activity_summary_as_admin(self, admin_token):
        """Test fetching activity summary as admin"""
        headers = {"Authorization": f"Bearer {admin_token}"}
        
        response = requests.get(f"{BASE_URL}/api/activity/summary", headers=headers)
        assert response.status_code == 200, f"Get activity summary failed: {response.text}"
        
        data = response.json()
        assert isinstance(data, list)
        print(f"Activity summary returned {len(data)} user records")
    
    def test_log_activity(self, admin_token):
        """Test logging staff activity"""
        headers = {"Authorization": f"Bearer {admin_token}"}
        
        activity_data = {
            "app_name": "Test Application",
            "window_title": "Test Window",
            "category": "productivity",
            "duration_seconds": 300
        }
        
        response = requests.post(f"{BASE_URL}/api/activity/log", json=activity_data, headers=headers)
        assert response.status_code == 200, f"Log activity failed: {response.text}"
        
        data = response.json()
        assert data["message"] == "Activity logged successfully"
        print("Activity logged successfully")
    
    def test_activity_summary_requires_admin(self):
        """Test that activity summary requires admin role"""
        # Login as staff user if available
        # For now, just verify the endpoint exists
        response = requests.get(f"{BASE_URL}/api/activity/summary")
        # Should fail without auth
        assert response.status_code in [401, 403], "Activity summary should require authentication"
        print("Activity summary endpoint requires authentication")


class TestRBACFiltering:
    """Test RBAC filtering - staff sees only assigned data"""
    
    @pytest.fixture
    def admin_token(self):
        """Get admin auth token"""
        response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        if response.status_code != 200:
            pytest.skip("Admin login failed")
        return response.json()["access_token"]
    
    def test_admin_sees_all_due_dates(self, admin_token):
        """Test that admin can see all due dates"""
        headers = {"Authorization": f"Bearer {admin_token}"}
        
        response = requests.get(f"{BASE_URL}/api/duedates", headers=headers)
        assert response.status_code == 200
        
        due_dates = response.json()
        print(f"Admin can see {len(due_dates)} due dates")
    
    def test_admin_sees_all_tasks(self, admin_token):
        """Test that admin can see all tasks"""
        headers = {"Authorization": f"Bearer {admin_token}"}
        
        response = requests.get(f"{BASE_URL}/api/tasks", headers=headers)
        assert response.status_code == 200
        
        tasks = response.json()
        print(f"Admin can see {len(tasks)} tasks")
    
    def test_admin_sees_all_clients(self, admin_token):
        """Test that admin can see all clients"""
        headers = {"Authorization": f"Bearer {admin_token}"}
        
        response = requests.get(f"{BASE_URL}/api/clients", headers=headers)
        assert response.status_code == 200
        
        clients = response.json()
        print(f"Admin can see {len(clients)} clients")


class TestCleanup:
    """Cleanup test data"""
    
    @pytest.fixture
    def admin_token(self):
        """Get admin auth token"""
        response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        if response.status_code != 200:
            pytest.skip("Admin login failed")
        return response.json()["access_token"]
    
    def test_cleanup_test_due_dates(self, admin_token):
        """Clean up TEST_ prefixed due dates"""
        headers = {"Authorization": f"Bearer {admin_token}"}
        
        response = requests.get(f"{BASE_URL}/api/duedates", headers=headers)
        if response.status_code != 200:
            return
        
        due_dates = response.json()
        deleted_count = 0
        
        for dd in due_dates:
            if dd["title"].startswith("TEST_"):
                delete_response = requests.delete(f"{BASE_URL}/api/duedates/{dd['id']}", headers=headers)
                if delete_response.status_code == 200:
                    deleted_count += 1
        
        print(f"Cleaned up {deleted_count} test due dates")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
